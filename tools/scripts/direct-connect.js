#!/usr/bin/env node
/**
 * Direct world server connection test (bypassing matchmaker)
 * 
 * Usage:
 *   node direct-connect.js [worldId] [gameKey]
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const WORLD_SERVER_URL = 'ws://localhost:7777';
const JWT_SECRET = 'dev-local-secret-change-in-production';
const WORLD_ID = process.argv[2] || 'local';
const GAME_KEY = process.argv[3] || 'cyberia';

console.log('🎮 Direct World Server Connection Test');
console.log('======================================');
console.log(`Server: ${WORLD_SERVER_URL}`);
console.log(`World ID: ${WORLD_ID}`);
console.log(`Game: ${GAME_KEY}`);
console.log('');

// Generate JWT token
const token = jwt.sign(
  {
    sub: 'test-user-' + Date.now(),
    gameKey: GAME_KEY,
    worldId: WORLD_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  },
  JWT_SECRET,
  { algorithm: 'HS256' }
);

console.log(`✓ Generated JWT token`);
console.log(`Token: ${token.substring(0, 30)}...`);
console.log('');

// Connect to world server
console.log('Connecting to world server...');
const ws = new WebSocket(WORLD_SERVER_URL);

let authenticated = false;
let joined = false;

ws.on('open', () => {
  console.log('✓ Connected to world server');
  console.log('');

  // Authenticate
  console.log('→ Sending auth...');
  ws.send(JSON.stringify({
    t: 'auth',
    token,
  }));

  // Wait a bit then join
  setTimeout(() => {
    if (authenticated) {
      console.log('→ Sending join...');
      ws.send(JSON.stringify({
        t: 'join',
        name: 'TestPlayer',
      }));
    }
  }, 100);

  // Send test input after joining
  setTimeout(() => {
    if (joined) {
      console.log('→ Sending test input (moving forward)...');
      ws.send(JSON.stringify({
        t: 'in',
        seq: 1,
        mx: 0,
        mz: 1,
        yaw: 0,
        jump: false,
      }));
    }
  }, 500);

  // Send ping
  setTimeout(() => {
    console.log('→ Sending ping...');
    ws.send(JSON.stringify({ t: 'ping' }));
  }, 1000);

  // Close after 2 seconds
  setTimeout(() => {
    console.log('');
    console.log('✓ Test complete, closing connection');
    ws.close();
  }, 2000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  console.log(`← ${msg.t}:`, JSON.stringify(msg, null, 2));

  if (msg.t === 'welcome') {
    authenticated = true;
  }

  if (msg.t === 'welcome') {
    joined = true;
  }

  if (msg.t === 'bootstrapRequired') {
    console.log('');
    console.log('ℹ️  World needs bootstrap data (first player)');
    console.log('   You can upload procedural terrain here');
  }

  if (msg.t === 'err') {
    console.error('');
    console.error('✗ Error from server:', msg.msg);
  }
});

ws.on('error', (error) => {
  console.error('');
  console.error('✗ Connection error:', error.message);
  console.error('');
  console.error('Make sure the world server is running:');
  console.error('  pnpm dev:worldserver');
  process.exit(1);
});

ws.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});
