import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

let apiClient: ApiGatewayManagementApiClient | null = null;

export function initApiClient(endpoint: string): void {
  apiClient = new ApiGatewayManagementApiClient({
    endpoint,
  });
}

export async function sendToConnection(
  connectionId: string,
  message: any
): Promise<void> {
  if (!apiClient) {
    throw new Error('API client not initialized');
  }

  await apiClient.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(message)),
    })
  );
}
