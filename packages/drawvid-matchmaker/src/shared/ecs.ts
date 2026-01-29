import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  StopTaskCommand,
  Task,
} from '@aws-sdk/client-ecs';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const ecsClient = new ECSClient({});
const ec2Client = new EC2Client({});
const elbv2Client = new ElasticLoadBalancingV2Client({});

export interface LaunchConfig {
  clusterArn: string;
  taskDefinitionArn: string;
  subnets: string[];
  securityGroup: string;
  gameKey: string;
  worldId: string;
  ddbTable: string;
  jwtSecret: string;
  region: string;
  taskRoleArn: string;
  executionRoleArn: string;
}

export async function launchWorldTask(config: LaunchConfig): Promise<{ arn: string; isNew: boolean }> {
  // First, check if any task is already running or starting
  console.log('[launchWorldTask] Checking if task already exists...');
  console.log('[launchWorldTask] Config:', {
    cluster: config.clusterArn,
    taskDefinition: config.taskDefinitionArn,
    subnets: config.subnets,
    securityGroup: config.securityGroup,
  });
  
  try {
    // Check for RUNNING or PROVISIONING tasks
    for (const desiredStatus of ['RUNNING', 'PROVISIONING']) {
      const listResult = await ecsClient.send(
        new ListTasksCommand({
          cluster: config.clusterArn,
          desiredStatus: desiredStatus as any,
        })
      );

      const taskArns = listResult.taskArns || [];
      console.log('[launchWorldTask] Found', taskArns.length, desiredStatus, 'tasks');

      // If there's already a task running or starting, reuse it
      if (taskArns.length > 0) {
        const existingTaskArn = taskArns[0]; // There should only be one
        console.log('[launchWorldTask] Reusing existing', desiredStatus, 'task:', existingTaskArn);
        return { arn: existingTaskArn, isNew: false }; // Mark as not new
      }
    }
  } catch (error) {
    console.error('[launchWorldTask] Error checking existing tasks:', error);
    // Continue with launching new task
  }

  // No task running or starting, launch a new one
  console.log('[launchWorldTask] Launching new world server task...');
  
  try {
    const result = await ecsClient.send(
      new RunTaskCommand({
        cluster: config.clusterArn,
        taskDefinition: config.taskDefinitionArn,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: config.subnets,
            securityGroups: [config.securityGroup],
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          taskRoleArn: config.taskRoleArn,
          executionRoleArn: config.executionRoleArn,
          containerOverrides: [
            {
              name: 'worldserver',
              environment: [
                { name: 'GAME_KEY', value: config.gameKey },
                { name: 'WORLD_ID', value: config.worldId },
                { name: 'DDB_TABLE', value: config.ddbTable },
                { name: 'JWT_SECRET', value: config.jwtSecret },
                { name: 'AWS_REGION', value: config.region },
                { name: 'WORLD_STORE_MODE', value: 'dynamodb' },
                // Pass cluster for self-stop capability (task ARN will be retrieved from ECS metadata)
                { name: 'ECS_CLUSTER_ARN', value: config.clusterArn },
              ],
            },
          ],
        },
      })
    );

    console.log('[launchWorldTask] RunTask response:', {
      tasks: result.tasks?.length,
      failures: result.failures?.length,
    });

    if (result.failures && result.failures.length > 0) {
      console.error('[launchWorldTask] Task launch failures:', result.failures);
      throw new Error(`Failed to launch task: ${result.failures[0].reason}`);
    }

    if (!result.tasks || result.tasks.length === 0) {
      throw new Error('Failed to launch task - no tasks returned');
    }

    const taskArn = result.tasks[0].taskArn!;
    const taskStatus = result.tasks[0];
    console.log('[launchWorldTask] New task launched:', {
      arn: taskArn,
      lastStatus: taskStatus.lastStatus,
      desiredStatus: taskStatus.desiredStatus,
    });
    return { arn: taskArn, isNew: true }; // Mark as new
  } catch (error: any) {
    console.error('[launchWorldTask] Error launching task:', error);
    throw error;
  }
}

export async function getTaskPublicIp(
  clusterArn: string,
  taskArn: string
): Promise<string | null> {
  const result = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: clusterArn,
      tasks: [taskArn],
    })
  );

  if (!result.tasks || result.tasks.length === 0) {
    return null;
  }

  const task = result.tasks[0];

  // Check if task is running
  if (task.lastStatus !== 'RUNNING') {
    return null;
  }

  // Find ENI attachment
  const eniAttachment = task.attachments?.find(
    (att) => att.type === 'ElasticNetworkInterface'
  );

  if (!eniAttachment) {
    return null;
  }

  const eniId = eniAttachment.details?.find(
    (detail) => detail.name === 'networkInterfaceId'
  )?.value;

  if (!eniId) {
    return null;
  }

  // Get public IP from ENI
  const eniResult = await ec2Client.send(
    new DescribeNetworkInterfacesCommand({
      NetworkInterfaceIds: [eniId],
    })
  );

  if (!eniResult.NetworkInterfaces || eniResult.NetworkInterfaces.length === 0) {
    return null;
  }

  const eni = eniResult.NetworkInterfaces[0];
  const publicIp = eni.Association?.PublicIp;
  const privateIp = eni.PrivateIpAddress;
  
  if (publicIp) {
    return publicIp;
  }

  // If no public IP, try to allocate and assign an Elastic IP
  try {
    console.log('[getTaskPublicIp] No public IP found, allocating Elastic IP...');
    
    // Allocate a new Elastic IP
    const allocResult = await ec2Client.send(
      new AllocateAddressCommand({
        Domain: 'vpc',
      })
    );

    if (!allocResult.PublicIp || !allocResult.AllocationId) {
      console.log('[getTaskPublicIp] Failed to allocate Elastic IP');
      return null;
    }

    // Associate the Elastic IP with the ENI
    console.log('[getTaskPublicIp] Associating Elastic IP:', allocResult.PublicIp);
    await ec2Client.send(
      new AssociateAddressCommand({
        AllocationId: allocResult.AllocationId,
        NetworkInterfaceId: eniId,
      })
    );

    console.log('[getTaskPublicIp] Elastic IP associated successfully');
    return allocResult.PublicIp;
  } catch (error: any) {
    console.error('[getTaskPublicIp] Error allocating/associating Elastic IP:', error);
    return null;
  }
}

export async function getTaskPrivateIp(
  clusterArn: string,
  taskArn: string
): Promise<string | null> {
  const result = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: clusterArn,
      tasks: [taskArn],
    })
  );

  if (!result.tasks || result.tasks.length === 0) {
    return null;
  }

  const task = result.tasks[0];

  // Check if task is running
  if (task.lastStatus !== 'RUNNING') {
    return null;
  }

  // Find ENI attachment
  const eniAttachment = task.attachments?.find(
    (att) => att.type === 'ElasticNetworkInterface'
  );

  if (!eniAttachment) {
    return null;
  }

  const eniId = eniAttachment.details?.find(
    (detail) => detail.name === 'networkInterfaceId'
  )?.value;

  if (!eniId) {
    return null;
  }

  // Get private IP from ENI
  const eniResult = await ec2Client.send(
    new DescribeNetworkInterfacesCommand({
      NetworkInterfaceIds: [eniId],
    })
  );

  if (!eniResult.NetworkInterfaces || eniResult.NetworkInterfaces.length === 0) {
    return null;
  }

  const eni = eniResult.NetworkInterfaces[0];
  return eni.PrivateIpAddress || null;
}

export async function waitForTaskRunning(
  clusterArn: string,
  taskArn: string,
  timeoutMs: number = 120000
): Promise<string> {
  const startTime = Date.now();
  let lastStatus = 'UNKNOWN';
  let lastStopCode = '';

  while (Date.now() - startTime < timeoutMs) {
    const result = await ecsClient.send(
      new DescribeTasksCommand({
        cluster: clusterArn,
        tasks: [taskArn],
      })
    );

    if (!result.tasks || result.tasks.length === 0) {
      console.log('[waitForTaskRunning] Task not found, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    const task = result.tasks[0];
    lastStatus = task.lastStatus || 'UNKNOWN';
    lastStopCode = task.stoppedReason || '';

    console.log('[waitForTaskRunning] Task status:', {
      lastStatus: task.lastStatus,
      desiredStatus: task.desiredStatus,
      stoppedReason: task.stoppedReason,
      stoppingAt: task.stoppingAt,
    });

    // Check if task is running
    if (task.lastStatus === 'RUNNING') {
      // Get the private IP from ENI for NLB registration
      const eniAttachment = task.attachments?.find(
        (att) => att.type === 'ElasticNetworkInterface'
      );

      if (eniAttachment) {
        const eniId = eniAttachment.details?.find(
          (detail) => detail.name === 'networkInterfaceId'
        )?.value;

        if (eniId) {
          const eniResult = await ec2Client.send(
            new DescribeNetworkInterfacesCommand({
              NetworkInterfaceIds: [eniId],
            })
          );

          if (eniResult.NetworkInterfaces && eniResult.NetworkInterfaces.length > 0) {
            const privateIp = eniResult.NetworkInterfaces[0].PrivateIpAddress;
            if (privateIp) {
              console.log('[waitForTaskRunning] Task running with private IP:', privateIp);
              return privateIp; // Return the private IP instead of public IP
            }
          }
        }
      }
    }

    // Check if task failed
    if (task.lastStatus === 'STOPPED' || task.desiredStatus === 'STOPPED') {
      throw new Error(`Task stopped: ${task.stoppedReason || 'Unknown reason'}`);
    }

    // Wait 3 seconds before checking again
    console.log('[waitForTaskRunning] Task not ready, waiting 3s...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(`Task did not reach RUNNING state within ${timeoutMs}ms. Last status: ${lastStatus}. Reason: ${lastStopCode}`);
}

export async function checkTaskRunning(taskArn: string): Promise<boolean> {
  try {
    const result = await ecsClient.send(
      new DescribeTasksCommand({
        cluster: 'drawvidverse-cluster', // Fallback cluster name
        tasks: [taskArn],
      })
    );

    if (!result.tasks || result.tasks.length === 0) {
      console.log('[checkTaskRunning] Task not found:', taskArn);
      return false;
    }

    const task = result.tasks[0];
    const isRunning = task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING';
    console.log('[checkTaskRunning] Task status:', { taskArn, lastStatus: task.lastStatus, desiredStatus: task.desiredStatus, isRunning });
    return isRunning;
  } catch (error: any) {
    console.error('[checkTaskRunning] Error checking task:', error);
    return false;
  }
}

export async function waitForTargetHealthy(
  targetGroupArn: string,
  taskArn: string,
  clusterArn: string,
  timeoutMs: number = 60000
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Get task to find its ENI
      const taskResult = await ecsClient.send(
        new DescribeTasksCommand({
          cluster: clusterArn,
          tasks: [taskArn],
        })
      );

      if (!taskResult.tasks || taskResult.tasks.length === 0) {
        console.log('[waitForTargetHealthy] Task not found');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const task = taskResult.tasks[0];
      const eni = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface')
        ?.details?.find((d) => d.name === 'networkInterfaceId')?.value;

      if (!eni) {
        console.log('[waitForTargetHealthy] Task has no ENI yet, waiting...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      // Check target health
      const healthResult = await elbv2Client.send(
        new DescribeTargetHealthCommand({
          TargetGroupArn: targetGroupArn,
        })
      );

      const target = healthResult.TargetHealthDescriptions?.find(
        (t: any) => t.Target?.Id === eni
      );

      if (!target) {
        console.log('[waitForTargetHealthy] Target not yet registered in target group');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      console.log('[waitForTargetHealthy] Target health:', target.TargetHealth?.State);

      if (target.TargetHealth?.State === 'healthy') {
        console.log('[waitForTargetHealthy] Target is healthy!');
        return true;
      }

      console.log('[waitForTargetHealthy] Target status:', target.TargetHealth?.State, target.TargetHealth?.Description);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error: any) {
      console.error('[waitForTargetHealthy] Error checking target health:', error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  console.warn('[waitForTargetHealthy] Timeout waiting for target to be healthy');
  return false;
}