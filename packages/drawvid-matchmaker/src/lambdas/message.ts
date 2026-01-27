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
import { launchWorldTask, waitForTaskRunning, registerTaskWithTargetGroup, waitForTargetHealthy } from '../shared/ecs.js';
import { issueWorldToken } from '../shared/jwt.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Environment variables
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const SUBNETS = process.env.SUBNETS!.split(',');
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const TARGET_GROUP_ARN = process.env.TARGET_GROUP_ARN!;
const DDB_TABLE = process.env.TABLE_NAME!;
const JWT_SECRET = process.env.JWT_SECRET!;
const AWS_REGION_CONFIG = process.env.AWS_REGION || 'us-east-2';

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
    
    if (!started) {
      // Someone else is starting it, wait and poll
      console.log('[joinWorld] Someone else starting, polling...');
      await sendToConnection(connectionId, {
        t: 'status',
        msg: 'STARTING',
      });

      // Poll until running - max 60 seconds (20 iterations of 3 second waits)
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
      console.log('[joinWorld] We started the world successfully');
    }
  } else {
    console.log('[joinWorld] World already running, status:', world.status);
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
    targetGroupArn: TARGET_GROUP_ARN,
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

  // Wait for task to be running and get private IP
  try {
    console.log('[tryStartWorld] Waiting for task to be running...');
    const privateIp = await waitForTaskRunning(ECS_CLUSTER_ARN, taskArn);
    console.log('[tryStartWorld] Task is running with private IP:', privateIp);

    // Only register and wait for health on new tasks
    if (isNewTask) {
      // Wait for world server to start listening
      console.log('[tryStartWorld] Waiting 10s for world server and NLB to initialize...');
      await new Promise((resolve) => setTimeout(resolve, 10000));

      // Register task with NLB target group
      console.log('[tryStartWorld] Registering task with NLB target group...');
      await registerTaskWithTargetGroup(TARGET_GROUP_ARN, ECS_CLUSTER_ARN, taskArn, 7777);
      console.log('[tryStartWorld] Task registered with target group');

      // Wait additional 30s for NLB health checks to complete
      console.log('[tryStartWorld] Waiting 30s for NLB health checks...');
      await new Promise((resolve) => setTimeout(resolve, 30000));
      console.log('[tryStartWorld] Ready for connections!');
    } else {
      console.log('[tryStartWorld] Task already running, skipping startup wait');
    }

    // Update world to running
    console.log('[tryStartWorld] Updating world to RUNNING');
    await updateWorldToRunning(gameKey, worldId, privateIp, gameConfig.worldServer.port);
    console.log('[tryStartWorld] World updated to RUNNING');

    return true;
  } catch (error: any) {
    console.error('[tryStartWorld] Failed to start world:', error);

    // Update to error
    await updateWorldToError(gameKey, worldId, error.message);

    throw error;
  }
}
