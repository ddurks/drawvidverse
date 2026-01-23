import { GameConfig } from '../app/config';
import { Vec3, AABB, vec3Add, vec3Scale, aabbIntersectsAABB } from './colliders';
import { WorldBootstrapPayload } from '../net/messages';

export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  grounded: boolean;
  jumpRequested: boolean;
}

export interface PlayerInput {
  mx: number; // movement x [-1, 1]
  mz: number; // movement z [-1, 1]
  yaw: number;
  jump: boolean;
}

export class Physics {
  private config: GameConfig;
  private seed?: number;
  private heightmapScale: number = 0.005;
  private heightmapAmplitude: number = 3;
  private terrainConfig?: {
    type: 'sinewave';
    frequency: number;
    amplitude: number;
    edgeBlendWidth: number;
    planeSize: number;
  };
  private terrainMesh?: {
    width: number;
    depth: number;
    sampleSize: number;
    heights: number[];
  };
  private aabbs: AABB[] = [];

  constructor(config: GameConfig) {
    this.config = config;
  }

  setBootstrap(bootstrap: WorldBootstrapPayload): void {
    this.seed = bootstrap.seed;
    
    if (bootstrap.terrainConfig) {
      this.terrainConfig = bootstrap.terrainConfig;
      console.log(`🗺️  Physics using sine wave terrain: freq=${this.terrainConfig.frequency}, amp=${this.terrainConfig.amplitude}`);
    } else if (bootstrap.heightmapConfig) {
      this.heightmapScale = bootstrap.heightmapConfig.scale;
      this.heightmapAmplitude = bootstrap.heightmapConfig.amplitude;
      console.log(`🗺️  Physics procedural terrain loaded: seed=${this.seed}, scale=${this.heightmapScale}, amplitude=${this.heightmapAmplitude}`);
    }
    
    if (bootstrap.terrainMesh) {
      this.terrainMesh = bootstrap.terrainMesh;
      console.log(`🗺️  Physics using client terrain mesh: ${this.terrainMesh.width}x${this.terrainMesh.depth}, ${this.terrainMesh.heights.length} heights`);
    }
    
    this.aabbs = bootstrap.colliders?.aabbs || [];
  }

  tick(player: PlayerState, input: PlayerInput, dt: number): void {
    const cfg = this.config.physics;

    // Update yaw from input
    player.yaw = input.yaw;

    // Movement input (normalize if needed)
    let mx = Math.max(-1, Math.min(1, input.mx));
    let mz = Math.max(-1, Math.min(1, input.mz));
    const inputLen = Math.sqrt(mx * mx + mz * mz);
    if (inputLen > 1) {
      mx /= inputLen;
      mz /= inputLen;
    }

    // Calculate world-space movement direction
    const cosYaw = Math.cos(player.yaw);
    const sinYaw = Math.sin(player.yaw);
    const worldMx = mx * cosYaw - mz * sinYaw;
    const worldMz = mx * sinYaw + mz * cosYaw;

    // Apply movement
    const moveControl = player.grounded ? 1.0 : cfg.airControl;
    player.velocity.x += worldMx * cfg.moveSpeed * moveControl * dt;
    player.velocity.z += worldMz * cfg.moveSpeed * moveControl * dt;

    // Apply ground friction or air drag
    // Much lighter friction to allow movement
    const isMoving = Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01;
    if (player.grounded) {
      const friction = isMoving ? 0.92 : 0.85; // Light friction when moving, moderate when stopped
      player.velocity.x *= friction;
      player.velocity.z *= friction;
    } else {
      player.velocity.x *= 0.98;
      player.velocity.z *= 0.98;
    }
    
    // Clamp small velocities to zero
    const velocityThreshold = 0.05;
    if (Math.abs(player.velocity.x) < velocityThreshold) player.velocity.x = 0;
    if (Math.abs(player.velocity.z) < velocityThreshold) player.velocity.z = 0;

    // Gravity
    player.velocity.y += cfg.gravity * dt;

    // Jump
    if (input.jump && player.grounded && !player.jumpRequested) {
      player.velocity.y = cfg.jumpSpeed;
      player.jumpRequested = true;
      player.grounded = false;
    }
    if (!input.jump) {
      player.jumpRequested = false;
    }

    // Integrate position
    const newPos: Vec3 = vec3Add(player.position, vec3Scale(player.velocity, dt));

    // Terrain collision
    const terrainY = this.getTerrainHeight(newPos.x, newPos.z);
    const groundY = terrainY + cfg.playerCapsule.radius;

    // Debug: log terrain heights occasionally
    if (Math.random() < 0.01) {
      console.log(`🏔️  Server terrain at (${newPos.x.toFixed(1)}, ${newPos.z.toFixed(1)}): terrainY=${terrainY.toFixed(2)}, groundY=${groundY.toFixed(2)}, playerY=${newPos.y.toFixed(2)}`);
    }

    if (newPos.y <= groundY) {
      newPos.y = groundY;
      player.velocity.y = Math.max(0, player.velocity.y);
      player.grounded = true;
    } else {
      player.grounded = false;
    }

    // AABB collision (simple push-out)
    this.resolveAABBCollisions(newPos, cfg.playerCapsule.radius);

    player.position = newPos;
  }

  private getTerrainHeight(x: number, z: number): number {
    // Priority 1: Use sine wave terrain config if available (matches client exactly)
    if (this.terrainConfig) {
      const { frequency, amplitude } = this.terrainConfig;
      
      // Simple sine wave - no edge blending needed for server physics
      // The client handles edge blending for visual smoothness between tiles
      const height = amplitude * Math.sin(frequency * x) * Math.sin(frequency * z);
      
      return height;
    }
    
    // Priority 2: If we have client terrain mesh, use bilinear interpolation from it
    if (this.terrainMesh) {
      const mesh = this.terrainMesh;
      const halfSize = mesh.sampleSize / 2;
      
      // Convert world coords to mesh local coords
      const localX = x + halfSize;
      const localZ = z + halfSize;
      
      // Convert to grid coords
      const gridX = (localX / mesh.sampleSize) * (mesh.width - 1);
      const gridZ = (localZ / mesh.sampleSize) * (mesh.depth - 1);
      
      const ix = Math.floor(gridX);
      const iz = Math.floor(gridZ);
      
      // Bounds check
      if (ix < 0 || iz < 0 || ix >= mesh.width - 1 || iz >= mesh.depth - 1) {
        // Outside sample area, fall back to procedural
        if (!this.seed) return 0;
        const nx = x * this.heightmapScale;
        const nz = z * this.heightmapScale;
        const noise1 = this.noise(nx, nz) * 1.0;
        const noise2 = this.noise(nx * 2, nz * 2) * 0.5;
        const noise3 = this.noise(nx * 4, nz * 4) * 0.25;
        return (noise1 + noise2 + noise3) * this.heightmapAmplitude;
      }
      
      // Bilinear interpolation
      const fx = gridX - ix;
      const fz = gridZ - iz;
      
      const h00 = mesh.heights[iz * mesh.width + ix];
      const h10 = mesh.heights[iz * mesh.width + (ix + 1)];
      const h01 = mesh.heights[(iz + 1) * mesh.width + ix];
      const h11 = mesh.heights[(iz + 1) * mesh.width + (ix + 1)];
      
      const h0 = h00 * (1 - fx) + h10 * fx;
      const h1 = h01 * (1 - fx) + h11 * fx;
      
      return h0 * (1 - fz) + h1 * fz;
    }
    
    // Fall back to procedural if no mesh
    if (!this.seed) {
      return 0;
    }

    // Multi-octave noise for smooth terrain (same as client)
    const nx = x * this.heightmapScale;
    const nz = z * this.heightmapScale;
    const noise1 = this.noise(nx, nz) * 1.0;
    const noise2 = this.noise(nx * 2, nz * 2) * 0.5;
    const noise3 = this.noise(nx * 4, nz * 4) * 0.25;
    
    return (noise1 + noise2 + noise3) * this.heightmapAmplitude;
  }

  // Same noise function as client worldgen.js
  private noise(x: number, z: number): number {
    const seed = this.seed!;
    x = x + seed;
    z = z + seed;
    
    const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  }

  private resolveAABBCollisions(position: Vec3, radius: number): void {
    // Simple capsule-as-sphere collision with AABBs
    for (const aabb of this.aabbs) {
      const closest: Vec3 = {
        x: Math.max(aabb.min.x, Math.min(position.x, aabb.max.x)),
        y: Math.max(aabb.min.y, Math.min(position.y, aabb.max.y)),
        z: Math.max(aabb.min.z, Math.min(position.z, aabb.max.z)),
      };

      const dx = position.x - closest.x;
      const dy = position.y - closest.y;
      const dz = position.z - closest.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < radius * radius) {
        const dist = Math.sqrt(distSq);
        if (dist > 0.001) {
          const pushOut = (radius - dist) / dist;
          position.x += dx * pushOut;
          position.y += dy * pushOut;
          position.z += dz * pushOut;
        }
      }
    }
  }
}
