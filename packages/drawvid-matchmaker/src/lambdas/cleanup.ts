import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { getIdleWorlds, updateWorldToStopped } from '../shared/ddb.js';

const ecsClient = new ECSClient({});
const IDLE_TIMEOUT_MINUTES = 5; // World server sends heartbeats every 2 minutes

export const handler = async (): Promise<void> => {
  console.log('[cleanup] Running idle world cleanup...');

  try {
    // Find all idle worlds
    const idleWorlds = await getIdleWorlds(IDLE_TIMEOUT_MINUTES);
    console.log('[cleanup] Found', idleWorlds.length, 'idle worlds');

    for (const world of idleWorlds) {
      console.log('[cleanup] Stopping idle world:', world.worldId);

      try {
        // Stop the ECS task
        if (world.taskArn) {
          console.log('[cleanup] Stopping task:', world.taskArn);
          await ecsClient.send(
            new StopTaskCommand({
              cluster: world.taskArn.split('/')[1], // Extract cluster name from ARN
              task: world.taskArn,
              reason: `Idle for ${IDLE_TIMEOUT_MINUTES} minutes`,
            })
          );
        }

        // Update world status to STOPPED
        await updateWorldToStopped(
          world.gameKey,
          world.worldId,
          `Stopped due to inactivity`
        );

        console.log('[cleanup] World stopped:', world.worldId);
      } catch (error: any) {
        console.error('[cleanup] Error stopping world', world.worldId, ':', error.message);
        // Continue with next world even if one fails
      }
    }

    console.log('[cleanup] Cleanup complete');
  } catch (error: any) {
    console.error('[cleanup] Fatal error:', error.message);
    throw error;
  }
};
