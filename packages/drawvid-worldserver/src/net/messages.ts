import { z } from 'zod';

// ============================================================================
// World Bootstrap
// ============================================================================

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const AABBSchema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
});

export const QuaternionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number(),
});

export const CylinderColliderSchema = z.object({
  position: Vec3Schema,
  quaternion: QuaternionSchema,
  radius: z.number(),
  height: z.number(),
});

export const HeightmapSchema = z.object({
  width: z.number().int().positive(),
  depth: z.number().int().positive(),
  cellSize: z.number().positive(),
  origin: z.object({
    x: z.number(),
    z: z.number(),
  }),
  heights: z.array(z.number()),
});

export const InstanceGroupSchema = z.object({
  kind: z.enum(['tree', 'rock', 'prop']),
  positions: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      yaw: z.number().optional(),
      scale: z.number().optional(),
      type: z.string().optional(), // Tree type for deterministic rendering
    })
  ),
});

export const WorldBootstrapPayloadSchema = z.object({
  seed: z.number(),
  terrainConfig: z.object({
    type: z.literal('sinewave'),
    frequency: z.number(),
    amplitude: z.number(),
    edgeBlendWidth: z.number(),
    planeSize: z.number(),
  }).optional(),
  heightmapConfig: z.object({
    scale: z.number(),
    amplitude: z.number(),
  }).optional(),
  terrainMesh: z.object({
    width: z.number(),
    depth: z.number(),
    sampleSize: z.number(),
    heights: z.array(z.number()),
  }).optional(),
  instances: z.array(InstanceGroupSchema),
  colliders: z
    .object({
      cylinders: z.array(CylinderColliderSchema).optional(), // New: Cannon.js cylinder colliders
      aabbs: z.array(AABBSchema).optional(), // Legacy: AABB colliders
    })
    .optional(),
});

export type WorldBootstrapPayload = z.infer<typeof WorldBootstrapPayloadSchema>;

// ============================================================================
// Client → Server Messages
// ============================================================================

export const AuthMessageSchema = z.object({
  t: z.literal('auth'),
  token: z.string(),
});

export const JoinMessageSchema = z.object({
  t: z.literal('join'),
  name: z.string().optional(),
  coatColor: z.object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  }).optional(),
});

export const InputMessageSchema = z.object({
  t: z.literal('in'),
  seq: z.number(),
  mx: z.number(),
  mz: z.number(),
  yaw: z.number(),
  jump: z.boolean(),
});

export const BootstrapUploadMessageSchema = z.object({
  t: z.literal('bootstrapUpload'),
  worldId: z.string(),
  version: z.number(),
  payload: WorldBootstrapPayloadSchema,
});

export const RTCOfferMessageSchema = z.object({
  t: z.literal('rtcOffer'),
  to: z.string(),
  sdp: z.string(),
});

export const RTCAnswerMessageSchema = z.object({
  t: z.literal('rtcAnswer'),
  to: z.string(),
  sdp: z.string(),
});

export const RTCIceMessageSchema = z.object({
  t: z.literal('rtcIce'),
  to: z.string(),
  candidate: z.string(),
});

export const PingMessageSchema = z.object({
  t: z.literal('ping'),
});

export const ClientMessageSchema = z.discriminatedUnion('t', [
  AuthMessageSchema,
  JoinMessageSchema,
  InputMessageSchema,
  BootstrapUploadMessageSchema,
  RTCOfferMessageSchema,
  RTCAnswerMessageSchema,
  RTCIceMessageSchema,
  PingMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ============================================================================
// Server → Client Messages
// ============================================================================

export interface WelcomeMessage {
  t: 'welcome';
  playerId: string;
  tickRate: number;
}

export interface BootstrapRequiredMessage {
  t: 'bootstrapRequired';
}

export interface BootstrapDataMessage {
  t: 'bootstrapData';
  payload: WorldBootstrapPayload;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  grounded: boolean;
  coatColor?: { r: number; g: number; b: number };
}

export interface SnapshotMessage {
  t: 's';
  tick: number;
  you: PlayerSnapshot;
  p: PlayerSnapshot[];
}

export interface VoicePeersMessage {
  t: 'voicePeers';
  peers: string[];
}

export interface ErrorMessage {
  t: 'err';
  code: string;
  msg: string;
}

export interface PongMessage {
  t: 'pong';
}

export type RTCOfferMessage = z.infer<typeof RTCOfferMessageSchema>;
export type RTCAnswerMessage = z.infer<typeof RTCAnswerMessageSchema>;
export type RTCIceMessage = z.infer<typeof RTCIceMessageSchema>;

export type ServerMessage =
  | WelcomeMessage
  | BootstrapRequiredMessage
  | BootstrapDataMessage
  | SnapshotMessage
  | VoicePeersMessage
  | ErrorMessage
  | PongMessage
  | RTCOfferMessage
  | RTCAnswerMessage
  | RTCIceMessage;
