import { WebSocketServer, WebSocket } from 'ws';
import { verify } from 'jsonwebtoken';
import { ServerConfig } from '../app/config';
import { logger } from '../app/logger';
import { World } from '../world/world';
import { ClientMessageSchema, ClientMessage } from './messages';
import { sendMessage, sendError } from './protocol';

interface ConnectionState {
  id: string;
  authenticated: boolean;
  playerId?: string;
  lastInputSeq: number;
  inputCount: number;
  signalingCount: number;
  bootstrapUploadCount: number;
  lastRateReset: number;
}

const connections = new Map<WebSocket, ConnectionState>();

// Rate limits (per second)
const RATE_LIMITS = {
  input: 200, // Allow bursts above 30Hz input rate (3x safety margin)
  signaling: 20,
  bootstrapUpload: 1,
};

export function createWSServer(config: ServerConfig, world: World): WebSocketServer {
  const wss = new WebSocketServer({
    port: config.gameConfig.worldServer.port,
    host: '0.0.0.0',
    perMessageDeflate: false, // Disable compression for better Safari compatibility
    clientTracking: true,
    maxPayload: 10 * 1024 * 1024, // 10MB
  });

  logger.info({ port: config.gameConfig.worldServer.port, host: '0.0.0.0' }, 'WebSocket server listening');

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    logger.info({ clientIp, userAgent, isIOS, headers: req.headers }, 'WebSocket connection established');
    const connId = generateConnectionId();
    const state: ConnectionState = {
      id: connId,
      authenticated: false,
      lastInputSeq: 0,
      inputCount: 0,
      signalingCount: 0,
      bootstrapUploadCount: 0,
      lastRateReset: Date.now(),
    };

    connections.set(ws, state);
    logger.info({ connId }, 'New WebSocket connection');

    // Auth timeout
    const authTimer = setTimeout(() => {
      if (!state.authenticated) {
        logger.warn({ connId }, 'Auth timeout');
        sendError(ws, 'AUTH_TIMEOUT', 'Authentication required within 5 seconds');
        ws.close();
      }
    }, 5000);

    ws.on('message', async (data: Buffer) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        const message = ClientMessageSchema.parse(parsed);

        // Rate limiting
        const now = Date.now();
        if (now - state.lastRateReset > 1000) {
          state.inputCount = 0;
          state.signalingCount = 0;
          state.bootstrapUploadCount = 0;
          state.lastRateReset = now;
        }

        await handleMessage(ws, state, message, config, world);
      } catch (error) {
        logger.warn({ connId, error }, 'Invalid message');
        sendError(ws, 'INVALID_MESSAGE', 'Invalid message format');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      connections.delete(ws);

      if (state.playerId) {
        world.removePlayer(state.playerId);
        logger.info({ connId, playerId: state.playerId }, 'Player disconnected');
      }
    });

    ws.on('error', (error) => {
      logger.error({ connId, error }, 'WebSocket error');
    });
  });

  return wss;
}

async function handleMessage(
  ws: WebSocket,
  state: ConnectionState,
  message: ClientMessage,
  config: ServerConfig,
  world: World
): Promise<void> {
  switch (message.t) {
    case 'auth':
      await handleAuth(ws, state, message.token, config, world);
      break;

    case 'join':
      if (!state.authenticated) {
        sendError(ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      await handleJoin(ws, state, message.name, world, message.coatColor);
      break;

    case 'in':
      if (!state.playerId) {
        sendError(ws, 'NOT_JOINED', 'Must join first');
        return;
      }
      // Check rate limit before incrementing to avoid compounding
      if (state.inputCount >= RATE_LIMITS.input) {
        logger.warn({ playerId: state.playerId, count: state.inputCount }, 'Input rate limit exceeded');
        sendError(ws, 'RATE_LIMIT', 'Too many input messages');
        return;
      }
      state.inputCount++;
      // Handle input message
      world.handleInput(state.playerId, message);
      break;

    case 'bootstrapUpload':
      if (!state.playerId) {
        sendError(ws, 'NOT_JOINED', 'Must join first');
        return;
      }
      if (++state.bootstrapUploadCount > RATE_LIMITS.bootstrapUpload) {
        sendError(ws, 'RATE_LIMIT', 'Too many bootstrap uploads');
        return;
      }
      await world.handleBootstrapUpload(state.playerId, message.payload);
      break;

    case 'rtcOffer':
    case 'rtcAnswer':
    case 'rtcIce':
      if (!state.playerId) {
        sendError(ws, 'NOT_JOINED', 'Must join first');
        return;
      }
      if (++state.signalingCount > RATE_LIMITS.signaling) {
        sendError(ws, 'RATE_LIMIT', 'Too many signaling messages');
        return;
      }
      world.handleSignaling(state.playerId, message);
      break;

    case 'ping':
      sendMessage(ws, { t: 'pong' });
      break;
  }
}

async function handleAuth(
  ws: WebSocket,
  state: ConnectionState,
  token: string,
  config: ServerConfig,
  world: World
): Promise<void> {
  try {
    // Bypass auth for local development
    if (token === 'local-dev-bypass' && config.worldId === 'local') {
      state.authenticated = true;
      logger.info({ connId: state.id }, 'Client authenticated (local dev bypass)');
      return;
    }

    const decoded = verify(token, config.jwtSecret) as any;

    if (decoded.worldId !== config.worldId || decoded.gameKey !== config.gameKey) {
      sendError(ws, 'INVALID_TOKEN', 'Token not valid for this world');
      ws.close();
      return;
    }

    state.authenticated = true;
    logger.info({ connId: state.id, sub: decoded.sub }, 'Client authenticated');
  } catch (error) {
    logger.warn({ connId: state.id, error }, 'Auth failed');
    sendError(ws, 'AUTH_FAILED', 'Invalid token');
    ws.close();
  }
}

async function handleJoin(
  ws: WebSocket,
  state: ConnectionState,
  name: string | undefined,
  world: World,
  coatColor?: { r: number; g: number; b: number }
): Promise<void> {
  if (state.playerId) {
    sendError(ws, 'ALREADY_JOINED', 'Already joined');
    return;
  }

  const playerId = generatePlayerId();
  state.playerId = playerId;

  await world.addPlayer(playerId, name || 'Player', ws, coatColor);

  sendMessage(ws, {
    t: 'welcome',
    playerId,
    tickRate: world.getTickRate(),
  });

  logger.info({ connId: state.id, playerId, name }, 'Player joined');
}

function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generatePlayerId(): string {
  return `p_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
