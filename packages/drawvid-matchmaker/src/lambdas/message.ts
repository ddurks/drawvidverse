import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { initApiClient, sendToConnection } from '../shared/apigateway.js';
import {
  getWorld,
  createWorld,
  updateWorldToStarting,
  updateWorldToRunning,
  updateWorldToError,
  updateConnectionWorld,
  makeWorldKey,
  updateWorldActivity,
} from '../shared/ddb.js';
import { launchWorldTask, waitForTaskRunning, checkTaskRunning, waitForTargetHealthy, debugNlbState } from '../shared/ecs.js';
import { issueWorldToken } from '../shared/jwt.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Environment variables
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const TASK_ROLE_ARN = process.env.TASK_ROLE_ARN!;
const TASK_EXECUTION_ROLE_ARN = process.env.TASK_EXECUTION_ROLE_ARN!;
const SUBNETS = process.env.SUBNETS!.split(',');
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const DDB_TABLE = process.env.TABLE_NAME!;
const JWT_SECRET = process.env.JWT_SECRET!;
const AWS_REGION_CONFIG = process.env.AWS_REGION || 'us-east-2';
const WORLD_SERVER_TARGET_GROUP_ARN = process.env.WORLD_SERVER_TARGET_GROUP_ARN!;

initApiClient(WEBSOCKET_ENDPOINT);

function loadGameConfig(gameKey: string): any {
  // Try to load from environment variable first (set by CDK)
  const envVarName = `GAME_CONFIG_${gameKey.toUpperCase()}`;
  const configFromEnv = process.env[envVarName];
  
  if (configFromEnv) {
    return JSON.parse(configFromEnv);
  }
  
  // Fallback: try to load from file (for local testing)
  try {
    const configPath = join(process.cwd(), '../../games', `${gameKey}.config.json`);
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not load config for game ${gameKey}: ${error}`);
  }
}

function generateWorldId(): string {
  return `w_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;

  try {
    const body = JSON.parse(event.body || '{}');
    const messageType = body.t;

    switch (messageType) {
      case 'createWorld':
        await handleCreateWorld(connectionId, body);
        break;

      case 'joinWorld':
        await handleJoinWorld(connectionId, body);
        break;

      case 'leaveWorld':
        await handleLeaveWorld(connectionId);
        break;

      case 'ping':
        await sendToConnection(connectionId, { t: 'pong' });
        break;

      default:
        await sendToConnection(connectionId, {
          t: 'err',
          code: 'UNKNOWN_MESSAGE',
          msg: `Unknown message type: ${messageType}`,
        });
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error: any) {
    console.error('Message handler error:', error);

    try {
      await sendToConnection(connectionId, {
        t: 'err',
        code: 'INTERNAL_ERROR',
        msg: error.message || 'Internal error',
      });
    } catch (sendError) {
      console.error('Failed to send error message:', sendError);
    }

    return { statusCode: 500, body: 'Internal error' };
  }
};

async function handleCreateWorld(connectionId: string, body: any): Promise<void> {
  const gameKey = body.gameKey;
  // IMPORTANT: For a given gameKey, ALWAYS use the same worldId
  // This ensures all players join the same world, regardless of what frontend sends
  const worldId = `world_${gameKey}_public`; // Fixed world ID per game

  console.log('[handleCreateWorld] Received request:', { gameKey, clientWorldId: body.worldId, usingWorldId: worldId });

  if (!gameKey) {
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'MISSING_GAME_KEY',
      msg: 'gameKey is required',
    });
    return;
  }

  // Load game config to get port
  const gameConfig = loadGameConfig(gameKey);
  const port = gameConfig.worldServer.port;

  // Create world in DDB (if doesn't exist)
  try {
    await createWorld(gameKey, worldId, port);
    console.log('[handleCreateWorld] Created new world:', { gameKey, worldId });
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log('[handleCreateWorld] World already exists, reusing:', { gameKey, worldId });
      // World already exists, that's fine
    } else {
      throw error;
    }
  }

  console.log('[handleCreateWorld] Sending response:', { worldId });
  await sendToConnection(connectionId, {
    t: 'worldCreated',
    worldId,
  });
}

async function handleJoinWorld(connectionId: string, body: any): Promise<void> {
  const gameKey = body.gameKey;
  const worldId = body.worldId;
  console.log('[joinWorld] Handler called with gameKey:', gameKey, 'worldId:', worldId);

  if (!gameKey || !worldId) {
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'MISSING_PARAMETERS',
      msg: 'gameKey and worldId are required',
    });
    return;
  }

  // Get world
  let world = await getWorld(gameKey, worldId);
  console.log('[joinWorld] Got world:', world);
  
  if (!world) {
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'WORLD_NOT_FOUND',
      msg: 'World does not exist',
    });
    return;
  }

  // If world is stopped or error, try to start it
  if (world.status === 'STOPPED' || world.status === 'ERROR') {
    console.log('[joinWorld] World status is', world.status, '- attempting to start');
    const started = await tryStartWorld(connectionId, gameKey, worldId);
    console.log('[joinWorld] tryStartWorld returned:', started);
  } else if (world.status === 'RUNNING' && world.taskArn) {
    // Even if marked RUNNING, verify task is actually running (might have crashed/stopped)
    console.log('[joinWorld] World marked RUNNING - verifying task is alive:', world.taskArn);
    const taskAlive = await checkTaskRunning(world.taskArn);
    if (!taskAlive) {
      console.log('[joinWorld] Task is not actually running - restarting world');
      await updateWorldToStarting(gameKey, worldId, world.taskArn); // Reset to STARTING
      const started = await tryStartWorld(connectionId, gameKey, worldId);
      console.log('[joinWorld] Restarted world, result:', started);
    }
  }

  // If world is not running, wait for it (whether we started it or not)
  if (world.status !== 'RUNNING') {
    console.log('[joinWorld] World not RUNNING yet (status:', world.status, ') - polling for startup...');
    await sendToConnection(connectionId, {
      t: 'status',
      msg: 'STARTING',
    });

    let pollCount = 0;
    for (let i = 0; i < 20; i++) {
      pollCount++;
      console.log('[joinWorld] Poll iteration', i, '- waiting 3 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 3000));

      world = await getWorld(gameKey, worldId);
      console.log('[joinWorld] Poll', i, '- world status:', world?.status, 'taskArn:', world?.taskArn);
      if (world && world.status === 'RUNNING') {
        console.log('[joinWorld] World is RUNNING after', pollCount, 'polls');
        break;
      }
    }

    if (!world || world.status !== 'RUNNING') {
      console.log('[joinWorld] Timeout after', pollCount, 'polls. Final status:', world?.status);
      await sendToConnection(connectionId, {
        t: 'err',
        code: 'START_TIMEOUT',
        msg: `World did not start. Status: ${world?.status || 'unknown'}`,
      });
      return;
    }
  } else {
    console.log('[joinWorld] World already running');
  }

  // Refresh world state
  world = await getWorld(gameKey, worldId);
  console.log('[joinWorld] Final world state:', JSON.stringify(world, null, 2));

  if (!world || world.status !== 'RUNNING') {
    console.log('[joinWorld] World not running, status:', world?.status);
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'WORLD_NOT_RUNNING',
      msg: `World status: ${world?.status || 'unknown'}`,
    });
    return;
  }

  console.log('[joinWorld] World is RUNNING, IP:', world.publicIp, 'Port:', world.port);
  
  if (!world.publicIp || !world.port) {
    console.log('[joinWorld] World missing endpoint details!');
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'WORLD_NO_ENDPOINT',
      msg: 'World is running but has no endpoint',
    });
    return;
  }

  // Verify NLB target is healthy before sending endpoint to client
  if (world.taskArn) {
    console.log('[joinWorld] Verifying NLB target is healthy...');
    console.log('[joinWorld] Task ARN:', world.taskArn);
    console.log('[joinWorld] Target Group ARN:', WORLD_SERVER_TARGET_GROUP_ARN);
    
    const targetHealthy = await waitForTargetHealthy(
      WORLD_SERVER_TARGET_GROUP_ARN,
      world.taskArn,
      ECS_CLUSTER_ARN,
      60000 // 60 second timeout - allows NLB health checks to pass (3x 6s interval + buffer)
    );
    
    if (!targetHealthy) {
      console.log('[joinWorld] ❌ NLB target not healthy - debugging state...');
      // Call debug function to help diagnose
      await debugNlbState(WORLD_SERVER_TARGET_GROUP_ARN, world.taskArn, ECS_CLUSTER_ARN);
      
      console.log('[joinWorld] Task likely needs restart, sending STARTING status and retrying...');
      // Send STARTING status to client so it knows to wait
      await sendToConnection(connectionId, {
        t: 'status',
        msg: 'STARTING',
      });
      // Retry this join after a delay
      setTimeout(() => {
        console.log('[joinWorld] Retrying joinWorld after task restart...');
        const body = { gameKey, worldId };
        handleJoinWorld(connectionId, body).catch(err => {
          console.error('[joinWorld] Retry failed:', err);
        });
      }, 3000);
      return;
    }
    console.log('[joinWorld] ✅ NLB target is healthy!');
  }

  // Update connection
  await updateConnectionWorld(connectionId, makeWorldKey(gameKey, worldId));

  // Update world activity time (prevent cleanup while players are joining)
  await updateWorldActivity(gameKey, worldId);

  // Issue JWT
  const gameConfig = loadGameConfig(gameKey);
  const token = issueWorldToken(
    connectionId,
    gameKey,
    worldId,
    gameConfig.security.jwtTtlSeconds,
    JWT_SECRET
  );

  console.log('[joinWorld] Sending joinResult with endpoint:', world.publicIp, world.port);
  // Send join result
  await sendToConnection(connectionId, {
    t: 'joinResult',
    worldId,
    endpoint: {
      ip: 'world.drawvid.com', // Use NLB domain instead of Elastic IP
      port: 443, // Use HTTPS/WSS standard port through NLB
    },
    token,
  });
  console.log('[joinWorld] joinResult sent successfully');
}

async function handleLeaveWorld(connectionId: string): Promise<void> {
  await updateConnectionWorld(connectionId, '');
  await sendToConnection(connectionId, {
    t: 'left',
  });
}

async function tryStartWorld(
  connectionId: string,
  gameKey: string,
  worldId: string
): Promise<boolean> {
  console.log('[tryStartWorld] Starting for', gameKey, '/', worldId);
  
  // Load game config
  const gameConfig = loadGameConfig(gameKey);

  // Launch or reuse task
  console.log('[tryStartWorld] Getting world server task...');
  const launchResult = await launchWorldTask({
    clusterArn: ECS_CLUSTER_ARN,
    taskDefinitionArn: TASK_DEFINITION_ARN,
    subnets: SUBNETS,
    securityGroup: SECURITY_GROUP,
    gameKey,
    worldId,
    ddbTable: DDB_TABLE,
    jwtSecret: JWT_SECRET,
    region: AWS_REGION_CONFIG,
    taskRoleArn: TASK_ROLE_ARN,
    executionRoleArn: TASK_EXECUTION_ROLE_ARN,
    targetGroupArn: WORLD_SERVER_TARGET_GROUP_ARN,
  });
  
  const taskArn = launchResult.arn;
  const isNewTask = launchResult.isNew;
  console.log('[tryStartWorld] Task:', taskArn, 'isNew:', isNewTask);

  // Try to claim start (conditional update)
  console.log('[tryStartWorld] Attempting to claim start...');
  const claimed = await updateWorldToStarting(gameKey, worldId, taskArn);
  console.log('[tryStartWorld] Claimed:', claimed);

  if (!claimed) {
    console.log('[tryStartWorld] Someone else is starting, returning false');
    return false; // Someone else is starting
  }

  // We claimed it, notify client
  console.log('[tryStartWorld] We claimed it, notifying client');
  await sendToConnection(connectionId, {
    t: 'status',
    msg: 'STARTING',
  });

  // Don't wait synchronously - launch async startup and return immediately
  // This prevents API Gateway WebSocket 3-second timeout
  console.log('[tryStartWorld] Launching async startup, returning immediately');
  
  // Fire and forget: start the task in the background
  (async () => {
    try {
      // Wait for task to be running and get private IP
      console.log('[tryStartWorld-async] Waiting for task to be running...');
      const privateIp = await waitForTaskRunning(ECS_CLUSTER_ARN, taskArn);
      console.log('[tryStartWorld-async] Task is running with private IP:', privateIp);

      // Wait for world server to start listening on port 7777
      // NLB will automatically discover the task via its health checks
      console.log('[tryStartWorld-async] Waiting 5s for world server to start listening...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log('[tryStartWorld-async] Ready for connections!');

      // Wait for NLB target to be healthy before returning endpoint to client
      console.log('[tryStartWorld-async] Waiting for NLB target to be healthy...');
      const targetHealthy = await waitForTargetHealthy(
        WORLD_SERVER_TARGET_GROUP_ARN,
        taskArn,
        ECS_CLUSTER_ARN
      );
      if (!targetHealthy) {
        throw new Error('NLB target did not become healthy within timeout');
      }
      console.log('[tryStartWorld-async] NLB target is healthy!');

      // Update world to running
      console.log('[tryStartWorld-async] Updating world to RUNNING');
      await updateWorldToRunning(gameKey, worldId, privateIp, gameConfig.worldServer.port);
      console.log('[tryStartWorld-async] World updated to RUNNING');
    } catch (error: any) {
      console.error('[tryStartWorld-async] Failed to start world:', error);
      // Update to error
      await updateWorldToError(gameKey, worldId, error.message);
    }
  })();

  return true;
}
