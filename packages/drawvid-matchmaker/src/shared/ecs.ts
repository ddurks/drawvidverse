import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  Task,
} from '@aws-sdk/client-ecs';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
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

export async function launchWorldTask(config: LaunchConfig): Promise<string> {
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
  return taskArn;
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

  const publicIp = eniResult.NetworkInterfaces[0].Association?.PublicIp;
  return publicIp || null;
}

export async function waitForTaskRunning(
  clusterArn: string,
  taskArn: string,
  timeoutMs: number = 120000
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const publicIp = await getTaskPublicIp(clusterArn, taskArn);

    if (publicIp) {
      return publicIp;
    }

    // Wait 3 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error('Task did not reach RUNNING state with public IP within timeout');
}
