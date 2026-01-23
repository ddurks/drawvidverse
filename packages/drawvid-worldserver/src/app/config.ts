import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { logger } from './logger';

const PlayerCapsuleSchema = z.object({
  radius: z.number(),
  height: z.number(),
});

const HeightmapClampSchema = z.object({
  min: z.number(),
  max: z.number(),
});

export const GameConfigSchema = z.object({
  gameKey: z.string(),
  worldServer: z.object({
    port: z.number(),
    tickHz: z.number(),
    snapshotHz: z.number(),
    maxPlayers: z.number(),
    cellSize: z.number(),
    visRadius: z.number(),
    voiceRadius: z.number(),
    emptyShutdownSeconds: z.number(),
    bootstrapMaxBytes: z.number(),
  }),
  physics: z.object({
    gravity: z.number(),
    jumpSpeed: z.number(),
    moveSpeed: z.number(),
    airControl: z.number(),
    playerCapsule: PlayerCapsuleSchema,
  }),
  world: z.object({
    bootstrapRequired: z.boolean(),
    heightmapClamp: HeightmapClampSchema,
    maxInstancesTotal: z.number(),
    maxAabbs: z.number(),
  }),
  security: z.object({
    jwtTtlSeconds: z.number(),
  }),
  aws: z.object({
    region: z.string(),
  }),
});

export type GameConfig = z.infer<typeof GameConfigSchema>;

export interface ServerConfig {
  gameKey: string;
  worldId: string;
  gameConfig: GameConfig;
  jwtSecret: string;
  ddbTable?: string;
  worldStoreMode: 'memory' | 'dynamodb';
  ecsClusterArn?: string;
  ecsTaskArn?: string;
  awsRegion?: string;
}

export function loadGameConfig(gameKey: string): GameConfig {
  // For v1: load from local file system
  // Future: load from S3 using CONFIG_BUCKET env var
  const configPath = join(process.cwd(), '../../games', `${gameKey}.config.json`);
  
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return GameConfigSchema.parse(parsed);
  } catch (error) {
    logger.error({ error, gameKey, configPath }, 'Failed to load game config');
    throw new Error(`Failed to load game config for ${gameKey}`);
  }
}

export function loadServerConfig(): ServerConfig {
  const gameKey = process.env.GAME_KEY;
  const worldId = process.env.WORLD_ID;
  const jwtSecret = process.env.JWT_SECRET;

  if (!gameKey || !worldId || !jwtSecret) {
    throw new Error('Missing required env vars: GAME_KEY, WORLD_ID, JWT_SECRET');
  }

  const gameConfig = loadGameConfig(gameKey);

  return {
    gameKey,
    worldId,
    gameConfig,
    jwtSecret,
    ddbTable: process.env.DDB_TABLE,
    worldStoreMode: (process.env.WORLD_STORE_MODE as 'memory' | 'dynamodb') || 'dynamodb',
    ecsClusterArn: process.env.ECS_CLUSTER_ARN,
    ecsTaskArn: process.env.ECS_TASK_ARN,
    awsRegion: process.env.AWS_REGION || gameConfig.aws.region,
  };
}
