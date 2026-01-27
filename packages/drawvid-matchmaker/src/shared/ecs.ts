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
  RegisterTargetsCommand,
  DescribeTargetHealthCommand,
  DeregisterTargetsCommand,
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
  targetGroupArn?: string; // NLB target group ARN for registration
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

export async function registerTaskWithTargetGroup(
  targetGroupArn: string,
  clusterArn: string,
  taskArn: string,
  targetPort: number = 7777
): Promise<void> {
  try {
    console.log('[registerTaskWithTargetGroup] Getting task private IP...');
    const privateIp = await getTaskPrivateIp(clusterArn, taskArn);

    if (!privateIp) {
      console.error('[registerTaskWithTargetGroup] Failed: Could not retrieve task private IP');
      throw new Error('Could not retrieve task private IP');
    }

    console.log('[registerTaskWithTargetGroup] Got private IP:', privateIp);
    console.log('[registerTaskWithTargetGroup] Registering target with:');
    console.log('  - Target Group ARN:', targetGroupArn);
    console.log('  - Target IP:', privateIp);
    console.log('  - Target Port:', targetPort);

    await elbv2Client.send(
      new RegisterTargetsCommand({
        TargetGroupArn: targetGroupArn,
        Targets: [
          {
            Id: privateIp,
            Port: targetPort,
          },
        ],
      })
    );

    console.log('[registerTaskWithTargetGroup] Target registered successfully');
  } catch (error: any) {
    console.error('[registerTaskWithTargetGroup] Error registering target:', error.message || error);
    console.error('[registerTaskWithTargetGroup] Full error:', error);
    throw error;
  }
}

export async function waitForTargetHealthy(
  targetGroupArn: string,
  targetIp: string,
  targetPort: number = 7777,
  timeoutMs: number = 120000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await elbv2Client.send(
        new DescribeTargetHealthCommand({
          TargetGroupArn: targetGroupArn,
        })
      );

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      
      if (result.TargetHealthDescriptions && result.TargetHealthDescriptions.length > 0) {
        const healthStates = result.TargetHealthDescriptions.map(h => ({
          id: h.Target?.Id,
          state: h.TargetHealth?.State,
          reason: h.TargetHealth?.Reason,
        }));

        console.log(`[waitForTargetHealthy] (${elapsedSec}s) Found ${result.TargetHealthDescriptions.length} targets:`, healthStates);

        // If ANY target is healthy, return success
        for (const health of result.TargetHealthDescriptions) {
          if (health.TargetHealth?.State === 'healthy') {
            console.log('[waitForTargetHealthy] ✓ Found healthy target!');
            return;
          }
        }

        // If we have targets but none are healthy yet, keep waiting
      } else {
        console.log(`[waitForTargetHealthy] (${elapsedSec}s) No targets registered yet`);
      }
    } catch (error: any) {
      console.error('[waitForTargetHealthy] Error:', error.message);
    }

    // Wait 2 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`No healthy targets found after ${timeoutMs}ms`);
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
export async function cleanupStaleTargets(targetGroupArn: string, clusterArn: string): Promise<void> {
  try {
    console.log('[cleanupStaleTargets] Starting deferred cleanup of old targets...');
    
    // Get all current targets in the target group
    const targetHealth = await elbv2Client.send(
      new DescribeTargetHealthCommand({
        TargetGroupArn: targetGroupArn,
      })
    );

    if (!targetHealth.TargetHealthDescriptions || targetHealth.TargetHealthDescriptions.length <= 1) {
      console.log('[cleanupStaleTargets] Only one target or fewer - no cleanup needed');
      return;
    }

    console.log('[cleanupStaleTargets] Found', targetHealth.TargetHealthDescriptions.length, 'targets');
    
    // Keep the most recently added target (newest), deregister all others
    // Sort by initial state to find the newest one (it will be in 'initial' or 'healthy' state)
    const targetsToDeregister: any[] = [];
    let healthyCount = 0;
    let initialCount = 0;

    for (const target of targetHealth.TargetHealthDescriptions) {
      const targetId = target.Target?.Id;
      const state = target.TargetHealth?.State;
      
      if (!targetId) continue;

      // Count healthy/initial targets (these are the newest ones we want to keep)
      if (state === 'healthy') healthyCount++;
      else if (state === 'initial') initialCount++;
      else {
        // Unhealthy or draining - definitely old, deregister it
        console.log('[cleanupStaleTargets] Deregistering unhealthy target:', targetId, 'state:', state);
        targetsToDeregister.push({
          Id: targetId,
          Port: target.Target?.Port || 7777,
        });
      }
    }

    // If we have multiple healthy targets, deregister all but the newest one
    let healthyTargets = targetHealth.TargetHealthDescriptions.filter(
      (t) => t.TargetHealth?.State === 'healthy'
    );
    
    if (healthyTargets.length > 1) {
      // Sort by ID (rough heuristic for "newest")
      healthyTargets = healthyTargets.sort(
        (a, b) => (b.Target?.Id || '').localeCompare(a.Target?.Id || '')
      );
      
      // Deregister all but the first one
      for (let i = 1; i < healthyTargets.length; i++) {
        const targetId = healthyTargets[i].Target?.Id;
        if (targetId) {
          console.log('[cleanupStaleTargets] Deregistering old healthy target:', targetId);
          targetsToDeregister.push({
            Id: targetId,
            Port: healthyTargets[i].Target?.Port || 7777,
          });
        }
      }
    }

    if (targetsToDeregister.length > 0) {
      console.log('[cleanupStaleTargets] Deregistering', targetsToDeregister.length, 'old targets');
      await elbv2Client.send(
        new DeregisterTargetsCommand({
          TargetGroupArn: targetGroupArn,
          Targets: targetsToDeregister,
        })
      );
      console.log('[cleanupStaleTargets] Deregistration complete');
    } else {
      console.log('[cleanupStaleTargets] No old targets to deregister');
    }
  } catch (error) {
    console.error('[cleanupStaleTargets] Error during cleanup:', error);
    // Don't fail the deployment due to cleanup errors
  }
}