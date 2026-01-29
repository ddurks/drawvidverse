import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { logger } from '../app/logger';

export async function stopECSTask(
  region: string,
  clusterArn: string,
  taskArn: string,
  gameKey?: string,
  worldId?: string,
  ddbTable?: string
): Promise<void> {
  const ecsClient = new ECSClient({ region });

  try {
    // Update DynamoDB to STOPPED before stopping the task
    if (gameKey && worldId && ddbTable) {
      logger.info({ gameKey, worldId }, 'Updating world status to STOPPED');
      const ddbClient = new DynamoDBClient({ region });
      
      await ddbClient.send(
        new UpdateItemCommand({
          TableName: ddbTable,
          Key: {
            pk: { S: `world#${gameKey}` },
            sk: { S: worldId },
          },
          UpdateExpression: 'SET #status = :stopped, updatedAt = :now',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':stopped': { S: 'STOPPED' },
            ':now': { N: String(Date.now()) },
          },
        })
      );
      
      logger.info({ gameKey, worldId }, 'World status updated to STOPPED');
    }

    logger.info({ clusterArn, taskArn }, 'Stopping ECS task (scale-to-zero)');

    await ecsClient.send(
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
