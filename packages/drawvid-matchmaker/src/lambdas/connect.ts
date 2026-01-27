import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { saveConnection } from '../shared/ddb.js';

export const handler = async (
  event: any
): Promise<APIGatewayProxyResultV2> => {
  const connectionId = event.requestContext.connectionId;
  console.log('[CONNECT] New connection:', connectionId);
  console.log('[CONNECT] Event context:', JSON.stringify(event.requestContext));

  try {
    // Log before saving
    console.log('[CONNECT] About to save connection...');
    await saveConnection(connectionId);
    console.log('[CONNECT] Connection saved successfully');

    // Echo back Sec-WebSocket-Protocol if present (case-insensitive)
    let response: APIGatewayProxyResultV2 = { statusCode: 200 };
    let subprotocol = null;
    if (event.headers) {
      // Check both lowercase and standard case
      subprotocol = event.headers['sec-websocket-protocol'] || event.headers['Sec-WebSocket-Protocol'];
    }
    if (subprotocol) {
      // If multiple protocols are sent, pick the first one (never echo back the token)
      const firstProtocol = subprotocol.split(',')[0].trim();
      response = {
        statusCode: 200,
        headers: {
          'Sec-WebSocket-Protocol': firstProtocol
        }
      };
      console.log('[CONNECT] Returning response: ', JSON.stringify(response), ' with subprotocol:', firstProtocol);
    } else {
      console.log('[CONNECT] Returning response without subprotocol');
    }
    return response;
  } catch (error) {
    console.error('[CONNECT] Error:', error);
    // Return 401 to deny the connection instead of 500
    return { statusCode: 401, body: 'Failed to connect' };
  }
};
