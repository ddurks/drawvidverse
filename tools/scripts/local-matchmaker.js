#!/usr/bin/env node
/**
 * Local development matchmaker
 * Runs a simple WebSocket server that mimics matchmaker behavior
 * but just returns localhost:7777 for all worlds
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const PORT = 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-local-secret-change-in-production';
const WORLD_SERVER_HOST = 'localhost';
const WORLD_SERVER_PORT = 7777;

const wss = new WebSocket.Server({ port: PORT });

console.log(`🎮 Local Matchmaker running on ws://localhost:${PORT}`);
console.log(`📡 World server expected at ws://${WORLD_SERVER_HOST}:${WORLD_SERVER_PORT}`);
console.log('');
console.log('Make sure to start the world server first:');
console.log('  pnpm dev:worldserver');
console.log('');

const worlds = new Map();
const connections = new Map();

wss.on('connection', (ws) => {
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  connections.set(connectionId, { ws });

  console.log(`✓ Client connected: ${connectionId}`);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(connectionId, ws, message);
    } catch (error) {
      console.error('Message error:', error);
      send(ws, { t: 'err', code: 'INVALID_MESSAGE', msg: error.message });
    }
  });

  ws.on('close', () => {
    console.log(`✗ Client disconnected: ${connectionId}`);
    connections.delete(connectionId);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleMessage(connectionId, ws, message) {
  console.log(`← ${connectionId}: ${message.t}`);

  switch (message.t) {
    case 'createWorld':
      handleCreateWorld(connectionId, ws, message);
      break;

    case 'joinWorld':
      handleJoinWorld(connectionId, ws, message);
      break;

    case 'leaveWorld':
      send(ws, { t: 'left' });
      break;

    case 'ping':
      send(ws, { t: 'pong' });
      break;

    default:
      send(ws, {
        t: 'err',
        code: 'UNKNOWN_MESSAGE',
        msg: `Unknown message type: ${message.t}`,
      });
  }
}

function handleCreateWorld(connectionId, ws, message) {
  const gameKey = message.gameKey || 'cyberia';
  const worldId = 'local'; // Always use 'local' for dev

  worlds.set(worldId, {
    gameKey,
    worldId,
    createdAt: Date.now(),
  });

  console.log(`  → Created world: ${worldId} (${gameKey})`);

  send(ws, {
    t: 'worldCreated',
    worldId,
  });
}

function handleJoinWorld(connectionId, ws, message) {
  const gameKey = message.gameKey || 'cyberia';
  const worldId = message.worldId;

  if (!worldId) {
    send(ws, {
      t: 'err',
      code: 'MISSING_WORLD_ID',
      msg: 'worldId is required',
    });
    return;
  }

  // In local mode, we always assume world server is running
  console.log(`  → Joining world: ${worldId} (${gameKey})`);

  // Generate JWT token
  const token = jwt.sign(
    {
      sub: connectionId,
      gameKey,
      worldId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
    },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  // Return local world server endpoint
  send(ws, {
    t: 'joinResult',
    worldId,
    endpoint: {
      ip: WORLD_SERVER_HOST,
      port: WORLD_SERVER_PORT,
    },
    token,
  });

  console.log(`  → Token issued for ${connectionId}`);
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function generateWorldId() {
  return `local_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down local matchmaker...');
  wss.close(() => {
    process.exit(0);
  });
});
