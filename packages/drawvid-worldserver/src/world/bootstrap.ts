import { GameConfig } from '../app/config';
import { WorldBootstrapPayload } from '../net/messages';
import { logger } from '../app/logger';

export function validateBootstrap(
  payload: WorldBootstrapPayload,
  config: GameConfig
): { valid: boolean; error?: string } {
  const { world, worldServer } = config;

  // Check payload size (approximate)
  const jsonSize = JSON.stringify(payload).length;
  if (jsonSize > worldServer.bootstrapMaxBytes) {
    return {
      valid: false,
      error: `Bootstrap payload too large: ${jsonSize} > ${worldServer.bootstrapMaxBytes}`,
    };
  }

  // Validate seed exists
  if (typeof payload.seed !== 'number') {
    return {
      valid: false,
      error: 'Bootstrap must contain a numeric seed',
    };
  }

  // Validate instances
  let totalInstances = 0;
  for (const group of payload.instances) {
    totalInstances += group.positions.length;
  }

  if (totalInstances > world.maxInstancesTotal) {
    return {
      valid: false,
      error: `Too many instances: ${totalInstances} > ${world.maxInstancesTotal}`,
    };
  }

  // Validate AABBs
  if (payload.colliders?.aabbs) {
    if (payload.colliders.aabbs.length > world.maxAabbs) {
      return {
        valid: false,
        error: `Too many AABBs: ${payload.colliders.aabbs.length} > ${world.maxAabbs}`,
      };
    }
  }

  logger.info(
    {
      seed: payload.seed,
      heightmapConfig: payload.heightmapConfig,
      instances: totalInstances,
      aabbs: payload.colliders?.aabbs?.length || 0,
    },
    'Bootstrap validated'
  );

  return { valid: true };
}
