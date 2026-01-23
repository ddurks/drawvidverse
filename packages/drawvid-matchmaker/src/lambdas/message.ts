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
} from '../shared/ddb.js';
import { launchWorldTask, waitForTaskRunning } from '../shared/ecs.js';
import { issueWorldToken } from '../shared/jwt.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Environment variables
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const SUBNETS = process.env.SUBNETS!.split(',');
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const DDB_TABLE = process.env.TABLE_NAME!;
const JWT_SECRET = process.env.JWT_SECRET!;
const AWS_REGION_CONFIG = process.env.AWS_REGION || 'us-east-2';

initApiClient(WEBSOCKET_ENDPOINT);

function loadGameConfig(gameKey: string): any {
  const configPath = join(process.cwd(), '../../games', `${gameKey}.config.json`);
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
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
  const worldId = body.worldId || generateWorldId();

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
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      // World already exists, that's fine
    } else {
      throw error;
    }
  }

  await sendToConnection(connectionId, {
    t: 'worldCreated',
    worldId,
  });
}

async function handleJoinWorld(connectionId: string, body: any): Promise<void> {
  const gameKey = body.gameKey;
  const worldId = body.worldId;

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
    const started = await tryStartWorld(connectionId, gameKey, worldId);
    if (!started) {
      // Someone else is starting it, wait and poll
      await sendToConnection(connectionId, {
        t: 'status',
        msg: 'STARTING',
      });

      // Poll until running
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        world = await getWorld(gameKey, worldId);
        if (world && world.status === 'RUNNING') {
          break;
        }
      }

      if (!world || world.status !== 'RUNNING') {
        await sendToConnection(connectionId, {
          t: 'err',
          code: 'START_TIMEOUT',
          msg: 'World did not start in time',
        });
        return;
      }
    }
  }

  // Refresh world state
  world = await getWorld(gameKey, worldId);

  if (!world || world.status !== 'RUNNING') {
    await sendToConnection(connectionId, {
      t: 'err',
      code: 'WORLD_NOT_RUNNING',
      msg: `World status: ${world?.status || 'unknown'}`,
    });
    return;
  }

  // Update connection
  await updateConnectionWorld(connectionId, makeWorldKey(gameKey, worldId));

  // Issue JWT
  const gameConfig = loadGameConfig(gameKey);
  const token = issueWorldToken(
    connectionId,
    gameKey,
    worldId,
    gameConfig.security.jwtTtlSeconds,
    JWT_SECRET
  );

  // Send join result
  await sendToConnection(connectionId, {
    t: 'joinResult',
    worldId,
    endpoint: {
      ip: world.publicIp,
      port: world.port,
    },
    token,
  });
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
  // Load game config
  const gameConfig = loadGameConfig(gameKey);

  // Launch task
  const taskArn = await launchWorldTask({
    clusterArn: ECS_CLUSTER_ARN,
    taskDefinitionArn: TASK_DEFINITION_ARN,
    subnets: SUBNETS,
    securityGroup: SECURITY_GROUP,
    gameKey,
    worldId,
    ddbTable: DDB_TABLE,
    jwtSecret: JWT_SECRET,
    region: AWS_REGION_CONFIG,
  });

  // Try to claim start (conditional update)
  const claimed = await updateWorldToStarting(gameKey, worldId, taskArn);

  if (!claimed) {
    return false; // Someone else is starting
  }

  // We claimed it, notify client
  await sendToConnection(connectionId, {
    t: 'status',
    msg: 'STARTING',
  });

  // Wait for task to be running and get public IP
  try {
    const publicIp = await waitForTaskRunning(ECS_CLUSTER_ARN, taskArn);

    // Update world to running
    await updateWorldToRunning(gameKey, worldId, publicIp, gameConfig.worldServer.port);

    return true;
  } catch (error: any) {
    console.error('Failed to start world:', error);

    // Update to error
    await updateWorldToError(gameKey, worldId, error.message);

    throw error;
  }
}
