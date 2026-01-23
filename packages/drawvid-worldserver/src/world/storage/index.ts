import { ServerConfig } from '../../app/config';
import { WorldStore } from './worldStore';
import { InMemoryWorldStore } from './inMemoryWorldStore';
import { DDBWorldStore } from './ddbWorldStore';

export function createWorldStore(config: ServerConfig): WorldStore {
  if (config.worldStoreMode === 'memory') {
    return new InMemoryWorldStore();
  }

  if (!config.ddbTable || !config.awsRegion) {
    throw new Error('DynamoDB mode requires DDB_TABLE and AWS_REGION');
  }

  return new DDBWorldStore(config.awsRegion, config.ddbTable);
}

export * from './worldStore';
export * from './inMemoryWorldStore';
export * from './ddbWorldStore';
