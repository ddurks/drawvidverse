import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

export interface WorldItem {
  pk: string;
  sk: string;
  worldId: string;
  gameKey: string;
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'ERROR';
  taskArn?: string;
  publicIp?: string;
  port?: number;
  region?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  errorReason?: string;
}

export interface ConnectionItem {
  pk: string;
  sk: string;
  connectionId: string;
  worldKey?: string;
  userId?: string;
  connectedAt: string;
}

export function makeWorldKey(gameKey: string, worldId: string): string {
  return `WORLD#${gameKey}#${worldId}`;
}

export async function getWorld(
  gameKey: string,
  worldId: string
): Promise<WorldItem | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: makeWorldKey(gameKey, worldId),
        sk: 'META',
      },
    })
  );

  return (result.Item as WorldItem) || null;
}

export async function createWorld(
  gameKey: string,
  worldId: string,
  port: number
): Promise<WorldItem> {
  const now = new Date().toISOString();
  const item: WorldItem = {
    pk: makeWorldKey(gameKey, worldId),
    sk: 'META',
    worldId,
    gameKey,
    status: 'STOPPED',
    port,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk)',
    })
  );

  return item;
}

export async function updateWorldToStarting(
  gameKey: string,
  worldId: string,
  taskArn: string
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: makeWorldKey(gameKey, worldId),
          sk: 'META',
        },
        UpdateExpression:
          'SET #status = :starting, taskArn = :taskArn, revision = revision + :one, updatedAt = :now',
        ConditionExpression: '#status IN (:stopped, :error)',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':starting': 'STARTING',
          ':stopped': 'STOPPED',
          ':error': 'ERROR',
          ':taskArn': taskArn,
          ':one': 1,
          ':now': new Date().toISOString(),
        },
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

export async function updateWorldToRunning(
  gameKey: string,
  worldId: string,
  publicIp: string,
  port: number
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: makeWorldKey(gameKey, worldId),
        sk: 'META',
      },
      UpdateExpression:
        'SET #status = :running, publicIp = :ip, port = :port, updatedAt = :now',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':running': 'RUNNING',
        ':ip': publicIp,
        ':port': port,
        ':now': new Date().toISOString(),
      },
    })
  );
}

export async function updateWorldToError(
  gameKey: string,
  worldId: string,
  errorReason: string
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: makeWorldKey(gameKey, worldId),
        sk: 'META',
      },
      UpdateExpression:
        'SET #status = :error, errorReason = :reason, updatedAt = :now',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':error': 'ERROR',
        ':reason': errorReason,
        ':now': new Date().toISOString(),
      },
    })
  );
}

export async function saveConnection(
  connectionId: string,
  userId?: string
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `CONN#${connectionId}`,
        sk: 'META',
        connectionId,
        userId,
        connectedAt: new Date().toISOString(),
      },
    })
  );
}

export async function getConnection(connectionId: string): Promise<ConnectionItem | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `CONN#${connectionId}`,
        sk: 'META',
      },
    })
  );

  return (result.Item as ConnectionItem) || null;
}

export async function updateConnectionWorld(
  connectionId: string,
  worldKey: string
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `CONN#${connectionId}`,
        sk: 'META',
      },
      UpdateExpression: 'SET worldKey = :worldKey',
      ExpressionAttributeValues: {
        ':worldKey': worldKey,
      },
    })
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `CONN#${connectionId}`,
        sk: 'META',
      },
    })
  );
}
