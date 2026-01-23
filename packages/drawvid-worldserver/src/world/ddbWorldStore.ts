import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { WorldStore } from './worldStore';
import { WorldBootstrapPayload } from '../net/messages';

export class DDBWorldStore implements WorldStore {
  private client: DynamoDBDocumentClient;
  private tableName: string;

  constructor(region: string, tableName: string) {
    const ddbClient = new DynamoDBClient({ region });
    this.client = DynamoDBDocumentClient.from(ddbClient);
    this.tableName = tableName;
  }

  async getBootstrap(worldId: string): Promise<WorldBootstrapPayload | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `BOOTSTRAP#${worldId}`,
          sk: 'DATA',
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return result.Item.payload as WorldBootstrapPayload;
  }

  async setBootstrapOnce(worldId: string, payload: WorldBootstrapPayload): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `BOOTSTRAP#${worldId}`,
            sk: 'DATA',
            payload,
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
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
}
