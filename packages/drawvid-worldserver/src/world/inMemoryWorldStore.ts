import { WorldStore } from './worldStore';
import { WorldBootstrapPayload } from '../net/messages';

export class InMemoryWorldStore implements WorldStore {
  private bootstrap: WorldBootstrapPayload | null = null;
  private set = false;

  async getBootstrap(worldId: string): Promise<WorldBootstrapPayload | null> {
    return this.bootstrap;
  }

  async setBootstrapOnce(worldId: string, payload: WorldBootstrapPayload): Promise<boolean> {
    if (this.set) {
      return false;
    }
    this.bootstrap = payload;
    this.set = true;
    return true;
  }
}
