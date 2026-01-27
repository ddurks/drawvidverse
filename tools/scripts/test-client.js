#!/usr/bin/env node
/**
 * Test client for matchmaker WebSocket API with timing
 * 
 * Usage:
 *   node test-client.js wss://your-api-id.execute-api.region.amazonaws.com/prod
 */

const WebSocket = require('ws');

const WS_URL = process.argv[2];
const startTime = Date.now();

const log = (msg) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[${elapsed}s] ${msg}`);
};

if (!WS_URL) {
  console.error('Usage: node test-client.js <websocket-url>');
  process.exit(1);
}

log(`Connecting to: ${WS_URL}`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  log('✓ Connected to matchmaker');

  // Create a world
  log('→ Creating world...');
  ws.send(JSON.stringify({
    t: 'createWorld',
    gameKey: 'cyberia',
  }));
});

let worldId;
let worldCreatedTime;
let statusReceivedTime;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.t === 'worldCreated') {
    worldCreatedTime = Date.now();
    const createTime = ((worldCreatedTime - startTime) / 1000).toFixed(2);
    worldId = msg.worldId;
    log(`← Received worldCreated after ${createTime}s: ${worldId}`);
    log(`→ Joining world: ${worldId}`);
    
    // Join the world
    ws.send(JSON.stringify({
      t: 'joinWorld',
      gameKey: 'cyberia',
      worldId,
    }));
  } else if (msg.t === 'status') {
    statusReceivedTime = Date.now();
    const statusTime = ((statusReceivedTime - startTime) / 1000).toFixed(2);
    log(`← Received status after ${statusTime}s: ${msg.msg}`);
    console.log('  └─ World is starting up...');
  } else if (msg.t === 'joinResult') {
    const joinTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const timeSinceStatus = statusReceivedTime ? ((Date.now() - statusReceivedTime) / 1000).toFixed(2) : 'N/A';
    log(`← Received joinResult after ${joinTime}s (${timeSinceStatus}s after status)`);
    
    console.log('\n' + '='.repeat(60));
    log(`✓ Successfully joined world!`);
    console.log('='.repeat(60));
    console.log(`World server endpoint: wss://${msg.endpoint.ip}:${msg.endpoint.port}`);
    console.log(`Token: ${msg.token.substring(0, 20)}...`);
    
    console.log('\n' + '='.repeat(60));
    console.log('TIMING SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total time: ${joinTime}s`);
    if (worldCreatedTime) {
      const toCreate = ((worldCreatedTime - startTime) / 1000).toFixed(2);
      console.log(`Time to world created: ${toCreate}s`);
    }
    if (statusReceivedTime) {
      const toStatus = ((statusReceivedTime - startTime) / 1000).toFixed(2);
      console.log(`Time to status: ${toStatus}s`);
    }
    console.log('='.repeat(60) + '\n');
    
    // Close after successful join
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 500);
  } else if (msg.t === 'err') {
    log(`✗ Error: ${msg.msg}`);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (error) => {
  log(`✗ WebSocket error: ${error.message}`);
  process.exit(1);
});

ws.on('close', () => {
  log('Connection closed');
});
