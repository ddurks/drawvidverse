import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { saveConnection } from '../shared/ddb.js';

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

    // Echo back Sec-WebSocket-Protocol if present
    let response: APIGatewayProxyResultV2 = { statusCode: 200 };
    const subprotocol = event.headers && event.headers['sec-websocket-protocol'];
    if (subprotocol) {
      response = {
        statusCode: 200,
        headers: {
          'Sec-WebSocket-Protocol': subprotocol
        }
      };
      console.log('[CONNECT] Returning response: ', JSON.stringify(response), ' with subprotocol:', subprotocol);
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
