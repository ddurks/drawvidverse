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

const ecsClient = new ECSClient({});
const ec2Client = new EC2Client({});

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
}

export async function launchWorldTask(config: LaunchConfig): Promise<{ arn: string; isNew: boolean }> {
  // First, check if any task is already running or starting
  console.log('[launchWorldTask] Checking if task already exists...');
  
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

  if (!result.tasks || result.tasks.length === 0) {
    throw new Error('Failed to launch task');
  }

  const taskArn = result.tasks[0].taskArn!;
  console.log('[launchWorldTask] New task launched:', taskArn);
  return { arn: taskArn, isNew: true }; // Mark as new
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

  while (Date.now() - startTime < timeoutMs) {
    const result = await ecsClient.send(
      new DescribeTasksCommand({
        cluster: clusterArn,
        tasks: [taskArn],
      })
    );

    if (!result.tasks || result.tasks.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    const task = result.tasks[0];

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

    // Wait 3 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error('Task did not reach RUNNING state with private IP within timeout');
}