import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { initApiClient, sendToConnection } from '../shared/apigateway.js';

// Initialize API client from env
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
initApiClient(WEBSOCKET_ENDPOINT);

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;

  try {
    await sendToConnection(connectionId, { t: 'pong' });

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Default handler error:', error);
    return { statusCode: 500, body: 'Internal error' };
  }
};
