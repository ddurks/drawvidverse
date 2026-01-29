import { WebSocketServer, WebSocket } from 'ws';
import { verify } from 'jsonwebtoken';
import { ServerConfig } from '../app/config';
import { logger } from '../app/logger';
import { World } from '../world/world';
import { ClientMessageSchema, ClientMessage } from './messages';
import { sendMessage, sendError } from './protocol';
import { stopECSTask } from '../aws/ecsSelfStop';

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

// Auto-stop configuration (in milliseconds)
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let lastPlayerDisconnectTime = 0;
let idleCheckInterval: NodeJS.Timeout | null = null;

// Rate limits (per second)
const RATE_LIMITS = {
  input: 200, // Allow bursts above 30Hz input rate (3x safety margin)
  signaling: 20,
  bootstrapUpload: 1,
};

export function createWSServer(config: ServerConfig, world: World): WebSocketServer {
  // NLB handles TLS termination, so we just use plain WebSocket
  // The browser connects to wss://world.drawvid.com:443 which the NLB forwards to our plain WS on :7777
  const wss = new WebSocketServer({
    port: config.gameConfig.worldServer.port,
    host: '0.0.0.0',
    perMessageDeflate: false, // Disable compression for better Safari compatibility
    clientTracking: true,
    maxPayload: 10 * 1024 * 1024, // 10MB
    verifyClient: (info, callback) => {
      // Handle WebSocket subprotocol negotiation for Chrome/Safari compatibility
      const requestedProtocols = info.req.headers['sec-websocket-protocol'];
      if (requestedProtocols) {
        // Echo back the first protocol (ignore any tokens sent as secondary protocols)
        const protocols = requestedProtocols.split(',');
        const firstProtocol = protocols[0].trim();
        logger.info({ protocols: requestedProtocols, echoing: firstProtocol }, 'Subprotocol negotiation');
        // Pass the selected protocol in response headers
        callback(true, undefined, undefined, { 'Sec-WebSocket-Protocol': firstProtocol });
      } else {
        callback(true);
      }
    },
  });

  logger.info({ port: config.gameConfig.worldServer.port, host: '0.0.0.0' }, 'WebSocket server listening (TLS handled by NLB)');

  // Start idle check: if no players for IDLE_TIMEOUT_MS, stop the task
  idleCheckInterval = setInterval(async () => {
    const connectedPlayerCount = Array.from(connections.values()).filter(c => c.playerId).length;
    
    if (connectedPlayerCount === 0) {
      const timeSinceLastDisconnect = Date.now() - lastPlayerDisconnectTime;
      
      logger.info(
        { timeSinceLastDisconnect, IDLE_TIMEOUT_MS },
        'Idle check: no players connected'
      );

      if (timeSinceLastDisconnect > IDLE_TIMEOUT_MS) {
        logger.info('World idle timeout reached, stopping task for scale-to-zero');
        
        try {
          let clusterArn = config.ecsClusterArn;
          let taskArn = config.ecsTaskArn;
          
          // If task ARN not provided, get it from ECS metadata endpoint
          if (!taskArn && process.env.ECS_CONTAINER_METADATA_URI_V4) {
            const metadataUrl = `${process.env.ECS_CONTAINER_METADATA_URI_V4}/task`;
            const response = await fetch(metadataUrl);
            const metadata = await response.json() as { TaskARN?: string };
            taskArn = metadata.TaskARN;
            logger.info({ taskArn }, 'Retrieved task ARN from metadata endpoint');
          }
          
          if (clusterArn && taskArn) {
            await stopECSTask(config.awsRegion || 'us-east-2', clusterArn, taskArn);
            logger.info('Successfully requested task stop');
          } else {
            logger.warn({ clusterArn, taskArn }, 'Missing clusterArn or taskArn, cannot stop task');
          }
        } catch (error) {
          logger.error({ error }, 'Failed to stop task');
        }
      }
    }
  }, 30 * 1000); // Check every 30 seconds

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    
    logger.info({ clientIp, userAgent, isIOS }, 'New WebSocket connection received');
    logger.info({ clientIp, userAgent, isIOS, headers: req.headers }, 'WebSocket connection established - new client connecting');
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
        logger.info({ connId, rawMessage: raw }, 'Received raw message from client');
        
        const parsed = JSON.parse(raw);
        logger.info({ connId, parsedMessage: JSON.stringify(parsed) }, 'Parsed message');
        
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
        logger.warn({ connId, error, rawData: data.toString() }, 'Invalid message');
        sendError(ws, 'INVALID_MESSAGE', 'Invalid message format');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      connections.delete(ws);

      if (state.playerId) {
        world.removePlayer(state.playerId);
        logger.info({ connId: state.id, playerId: state.playerId }, 'Player disconnected');
        
        // Track when last player disconnected for idle timeout
        lastPlayerDisconnectTime = Date.now();
      }
    });

    ws.on('error', (error) => {
      logger.error({ connId, error }, 'WebSocket error');
    });
  });

  // Store cleanup function for graceful shutdown
  (wss as any).cleanupIdleCheck = () => {
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
  };

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
      
      // Handle full bootstrap upload
      if (message.payload) {
        await world.handleBootstrapUpload(state.playerId, message.payload);
      }
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
    
    logger.info({
      connId: state.id,
      token: token.substring(0, 50) + '...',
      decodedToken: JSON.stringify(decoded),
      decodedWorldId: decoded.worldId,
      configWorldId: config.worldId,
      decodedGameKey: decoded.gameKey,
      configGameKey: config.gameKey,
      worldIdMatch: decoded.worldId === config.worldId,
      gameKeyMatch: decoded.gameKey === config.gameKey,
    }, 'Token decoded and validation check');

    if (decoded.worldId !== config.worldId || decoded.gameKey !== config.gameKey) {
      logger.warn({
        connId: state.id,
        decodedWorldId: decoded.worldId,
        configWorldId: config.worldId,
        decodedGameKey: decoded.gameKey,
        configGameKey: config.gameKey,
        worldIdMatch: decoded.worldId === config.worldId,
        gameKeyMatch: decoded.gameKey === config.gameKey,
      }, 'Token validation failed - worldId or gameKey mismatch');
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
