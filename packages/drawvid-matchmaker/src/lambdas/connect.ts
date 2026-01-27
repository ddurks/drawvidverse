import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { saveConnection } from '../shared/ddb.js';

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;
  console.log('[CONNECT] New connection:', connectionId);
  console.log('[CONNECT] Event context:', JSON.stringify(event.requestContext));

  try {
    // Log before saving
    console.log('[CONNECT] About to save connection...');
    await saveConnection(connectionId);
    console.log('[CONNECT] Connection saved successfully');

    // Return 200 to allow the connection
    const response = { statusCode: 200 };
    console.log('[CONNECT] Returning response:', JSON.stringify(response));
    return response;
  } catch (error) {
    console.error('[CONNECT] Error:', error);
    // Return 401 to deny the connection instead of 500
    return { statusCode: 401, body: 'Failed to connect' };
  }
};
