import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { logger } from '../app/logger';

export async function stopECSTask(
  region: string,
  clusterArn: string,
  taskArn: string
): Promise<void> {
  const client = new ECSClient({ region });

  try {
    logger.info({ clusterArn, taskArn }, 'Stopping ECS task (scale-to-zero)');

    await client.send(
      new StopTaskCommand({
        cluster: clusterArn,
        task: taskArn,
        reason: 'World empty for configured duration (scale-to-zero)',
      })
    );

    logger.info('ECS task stop requested successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to stop ECS task');
    throw error;
  }
}
