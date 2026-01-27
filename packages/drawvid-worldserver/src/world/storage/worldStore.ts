import { WorldBootstrapPayload } from '../../net/messages';

export interface WorldStore {
  getBootstrap(worldId: string): Promise<WorldBootstrapPayload | null>;
  setBootstrapOnce(worldId: string, payload: WorldBootstrapPayload): Promise<boolean>;
  updateActivity?(): Promise<void>;
}
