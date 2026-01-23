#!/usr/bin/env node
/**
 * Test client for matchmaker WebSocket API
 * 
 * Usage:
 *   node test-client.js wss://your-api-id.execute-api.region.amazonaws.com/prod
 */

const WebSocket = require('ws');

const WS_URL = process.argv[2];

if (!WS_URL) {
  console.error('Usage: node test-client.js <websocket-url>');
  process.exit(1);
}

console.log('Connecting to:', WS_URL);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✓ Connected');

  // Create a world
  console.log('\n→ Creating world...');
  ws.send(JSON.stringify({
    t: 'createWorld',
    gameKey: 'cyberia',
  }));
});

let worldId;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('← Received:', JSON.stringify(msg, null, 2));

  if (msg.t === 'worldCreated') {
    worldId = msg.worldId;
    console.log('\n→ Joining world:', worldId);
    
    // Join the world
    ws.send(JSON.stringify({
      t: 'joinWorld',
      gameKey: 'cyberia',
      worldId,
    }));
  }

  if (msg.t === 'joinResult') {
    console.log('\n✓ Successfully joined world!');
    console.log('World server endpoint:', msg.endpoint);
    console.log('Token:', msg.token.substring(0, 20) + '...');
    console.log('\nYou can now connect to the world server using:');
    console.log(`  ws://${msg.endpoint.ip}:${msg.endpoint.port}`);
    console.log(`  Auth token: ${msg.token}`);
    
    // Close after successful join
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 1000);
  }

  if (msg.t === 'err') {
    console.error('\n✗ Error:', msg.msg);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
  process.exit(1);
});

ws.on('close', () => {
  console.log('\nConnection closed');
});
