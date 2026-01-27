import WebSocket from 'ws';
import { z } from 'zod';
import { ServerConfig } from '../app/config';
import { logger } from '../app/logger';
import { WorldStore } from './storage/worldStore';
import { Physics, PlayerState, PlayerInput } from './physics/physics';
import { SpatialHash } from './physics/spatialHash';
import { validateBootstrap } from './bootstrap';
import { computeProximityPeers } from '../voice/proximityVoice';
import { SignalingRelay, SignalingMessage } from '../voice/signalingRelay';
import { sendMessage, sendError } from '../net/protocol';
import {
  WorldBootstrapPayload,
  InputMessageSchema,
  PlayerSnapshot,
} from '../net/messages';
import { stopECSTask } from '../aws/ecsSelfStop';

interface Player {
  id: string;
  name: string;
  ws: WebSocket;
  state: PlayerState;
  lastInputSeq: number;
}

export class World {
  private config: ServerConfig;
  private store: WorldStore;
  private physics: Physics;
  private spatial: SpatialHash;
  private signalingRelay: SignalingRelay;

  private players: Map<string, Player> = new Map();
  private tickInterval?: NodeJS.Timeout;
  private snapshotInterval?: NodeJS.Timeout;
  private emptyCheckInterval?: NodeJS.Timeout;
  private activityHeartbeatInterval?: NodeJS.Timeout;

  private currentTick = 0;
  private bootstrapLoaded = false;
  private bootstrapOwnerId?: string;
  private emptyStartTime?: number;

  constructor(config: ServerConfig, store: WorldStore) {
    this.config = config;
    this.store = store;
    this.physics = new Physics(config.gameConfig);
    this.spatial = new SpatialHash(config.gameConfig.worldServer.cellSize);
    this.signalingRelay = new SignalingRelay();
  }

  async init(): Promise<void> {
    // Try to load existing bootstrap
    const bootstrap = await this.store.getBootstrap(this.config.worldId);
    if (bootstrap) {
      this.physics.setBootstrap(bootstrap);
      this.bootstrapLoaded = true;
      logger.info('Loaded existing world bootstrap');
    } else {
      logger.info('No bootstrap found, will require upload from first player');
    }

    // Start simulation
    this.startSimulation();

    // Start empty check for scale-to-zero
    this.startEmptyCheck();

    // Start activity heartbeat to prevent premature cleanup
    this.startActivityHeartbeat();
  }

  async shutdown(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
    }
    if (this.emptyCheckInterval) {
      clearInterval(this.emptyCheckInterval);
    }
    if (this.activityHeartbeatInterval) {
      clearInterval(this.activityHeartbeatInterval);
    }

    for (const player of this.players.values()) {
      player.ws.close();
    }

    logger.info('World shutdown complete');
  }

  async addPlayer(playerId: string, name: string, ws: WebSocket, coatColor?: { r: number; g: number; b: number }): Promise<void> {
    // Spawn position (center of world or near origin)
    const spawnPos = { x: 0, y: 50, z: 0 };

    const player: Player = {
      id: playerId,
      name,
      ws,
      state: {
        position: spawnPos,
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 0,
        grounded: false,
        jumpRequested: false,
        coatColor,
      },
      lastInputSeq: 0,
    };

    this.players.set(playerId, player);
    this.spatial.insert(playerId, player.state.position);
    this.signalingRelay.registerPlayer(playerId, ws);

    logger.info({ playerId, name }, 'Player added to world');

    // If no bootstrap and this is the first player, request upload
    if (!this.bootstrapLoaded && this.players.size === 1) {
      this.bootstrapOwnerId = playerId;
      sendMessage(ws, { t: 'bootstrapRequired' });
      logger.info({ playerId }, 'Requested bootstrap upload from first player');
    } else if (this.bootstrapLoaded) {
      // Send bootstrap to new player
      const bootstrap = await this.store.getBootstrap(this.config.worldId);
      if (bootstrap) {
        sendMessage(ws, { t: 'bootstrapData', payload: bootstrap });
      }
    }

    // Reset empty timer
    this.emptyStartTime = undefined;
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.spatial.remove(playerId, player.state.position);
    this.signalingRelay.unregisterPlayer(playerId);
    this.players.delete(playerId);

    logger.info({ playerId }, 'Player removed from world');

    // Start empty timer if world is now empty
    if (this.players.size === 0) {
      this.emptyStartTime = Date.now();
      logger.info('World is now empty, starting shutdown timer');
    }
  }

  handleInput(playerId: string, input: z.infer<typeof InputMessageSchema>): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Ignore old inputs
    if (input.seq <= player.lastInputSeq) {
      return;
    }

    player.lastInputSeq = input.seq;

    // Queue input for next tick (for simplicity, just apply immediately)
    const playerInput: PlayerInput = {
      mx: input.mx,
      mz: input.mz,
      yaw: input.yaw,
      jump: input.jump,
    };

    // Apply physics immediately (could also queue for tick)
    const dt = 1 / this.config.gameConfig.worldServer.tickHz;
    const oldPos = { ...player.state.position };
    this.physics.tick(player.state, playerInput, dt);
    this.spatial.update(playerId, oldPos, player.state.position);
  }

  async handleBootstrapUpload(
    playerId: string,
    payload: WorldBootstrapPayload
  ): Promise<void> {
    logger.info({ playerId }, 'Bootstrap upload received');
    
    const player = this.players.get(playerId);
    if (!player) {
      return;
    }

    // Only allow bootstrap from the designated owner
    if (this.bootstrapOwnerId !== playerId) {
      sendError(player.ws, 'BOOTSTRAP_DENIED', 'Only first player can upload bootstrap');
      return;
    }

    if (this.bootstrapLoaded) {
      sendError(player.ws, 'BOOTSTRAP_EXISTS', 'Bootstrap already set');
      return;
    }

    // Validate
    const validation = validateBootstrap(payload, this.config.gameConfig);
    if (!validation.valid) {
      sendError(player.ws, 'BOOTSTRAP_INVALID', validation.error!);
      return;
    }

    // Store (conditional write)
    const success = await this.store.setBootstrapOnce(this.config.worldId, payload);
    if (!success) {
      sendError(player.ws, 'BOOTSTRAP_RACE', 'Bootstrap was set by another process');
      return;
    }

    // Load into physics
    this.physics.setBootstrap(payload);
    this.bootstrapLoaded = true;

    logger.info({ playerId, seed: payload.seed }, 'Bootstrap stored successfully');

    // Broadcast to all players
    for (const p of this.players.values()) {
      sendMessage(p.ws, { t: 'bootstrapData', payload });
    }
  }

  handleSignaling(playerId: string, message: SignalingMessage): void {
    this.signalingRelay.relaySignaling(playerId, message);
  }

  getTickRate(): number {
    return this.config.gameConfig.worldServer.tickHz;
  }

  private startSimulation(): void {
    const tickHz = this.config.gameConfig.worldServer.tickHz;
    const snapshotHz = this.config.gameConfig.worldServer.snapshotHz;

    this.tickInterval = setInterval(() => {
      this.tick();
    }, 1000 / tickHz);

    this.snapshotInterval = setInterval(() => {
      this.sendSnapshots();
    }, 1000 / snapshotHz);

    logger.info({ tickHz, snapshotHz }, 'Simulation started');
  }

  private tick(): void {
    this.currentTick++;

    // Physics is already applied in handleInput for simplicity
    // In production, you might queue inputs and process them here
  }

  private sendSnapshots(): void {
    if (this.players.size === 0) return;

    // Update voice peers
    const playerPositions = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      position: p.state.position,
    }));

    const voicePeers = computeProximityPeers(
      playerPositions,
      this.config.gameConfig.worldServer.voiceRadius
    );

    this.signalingRelay.updateVoicePeers(voicePeers);

    // Send snapshot to each player
    for (const player of this.players.values()) {
      // Get nearby players using spatial hash
      const nearby = this.spatial.queryRadius(
        player.state.position,
        this.config.gameConfig.worldServer.visRadius
      );

      const otherPlayers: PlayerSnapshot[] = [];

      for (const nearbyId of nearby) {
        if (nearbyId === player.id) continue;

        const other = this.players.get(nearbyId);
        if (!other) continue;

        otherPlayers.push(this.serializePlayer(other));
      }

      sendMessage(player.ws, {
        t: 's',
        tick: this.currentTick,
        you: this.serializePlayer(player),
        p: otherPlayers,
      });
    }
  }

  private serializePlayer(player: Player): PlayerSnapshot {
    return {
      id: player.id,
      name: player.name,
      x: player.state.position.x,
      y: player.state.position.y,
      z: player.state.position.z,
      vx: player.state.velocity.x,
      vy: player.state.velocity.y,
      vz: player.state.velocity.z,
      yaw: player.state.yaw,
      grounded: player.state.grounded,
      coatColor: player.state.coatColor,
    };
  }

  private startEmptyCheck(): void {
    this.emptyCheckInterval = setInterval(() => {
      this.checkEmptyShutdown();
    }, 5000); // Check every 5 seconds
  }

  private startActivityHeartbeat(): void {
    // Update DynamoDB activity timestamp every 2 minutes to prevent idle cleanup
    this.activityHeartbeatInterval = setInterval(async () => {
      if (this.players.size > 0 && this.store.updateActivity) {
        try {
          await this.store.updateActivity();
          logger.debug({ playerCount: this.players.size }, 'Activity heartbeat sent');
        } catch (error) {
          logger.error({ error }, 'Failed to send activity heartbeat');
        }
      }
    }, 2 * 60 * 1000); // Every 2 minutes
  }

  private async checkEmptyShutdown(): Promise<void> {
    if (this.players.size > 0) {
      return;
    }

    if (!this.emptyStartTime) {
      return;
    }

    const emptyDuration = (Date.now() - this.emptyStartTime) / 1000;
    const threshold = this.config.gameConfig.worldServer.emptyShutdownSeconds;

    if (emptyDuration >= threshold) {
      logger.info(
        { emptyDuration, threshold },
        'World empty threshold reached, initiating self-stop'
      );

      // Only self-stop if running in ECS
      if (this.config.ecsClusterArn && this.config.ecsTaskArn && this.config.awsRegion) {
        try {
          await stopECSTask(
            this.config.awsRegion,
            this.config.ecsClusterArn,
            this.config.ecsTaskArn
          );

          // Exit after requesting stop
          process.exit(0);
        } catch (error) {
          logger.error({ error }, 'Failed to self-stop, continuing to run');
        }
      } else {
        logger.info('Not in ECS mode, skipping self-stop');
      }
    }
  }
}
