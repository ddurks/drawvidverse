import { WebSocketServer } from 'ws';
import { logger } from './logger';
import { loadServerConfig, ServerConfig } from './config';
import { createWSServer } from '../net/wsServer';
import { World } from '../world/world';
import { createWorldStore } from '../world/storage';

export class Server {
  private config: ServerConfig;
  private wss?: WebSocketServer;
  private world?: World;

  constructor() {
    this.config = loadServerConfig();
  }

  async start(): Promise<void> {
    logger.info(
      {
        gameKey: this.config.gameKey,
        worldId: this.config.worldId,
        port: this.config.gameConfig.worldServer.port,
      },
      'Starting world server'
    );

    // Initialize world store
    const worldStore = createWorldStore(this.config);

    // Create world instance
    this.world = new World(this.config, worldStore);
    await this.world.init();

    // Start WebSocket server (async - loads certs from Secrets Manager)
    this.wss = await createWSServer(this.config, this.world);

    logger.info(
      { port: this.config.gameConfig.worldServer.port },
      'World server started'
    );
  }

  async stop(): Promise<void> {
    logger.info('Stopping world server');

    if (this.world) {
      await this.world.shutdown();
    }

    if (this.wss) {
      // Cleanup idle check interval
      if ((this.wss as any).cleanupIdleCheck) {
        (this.wss as any).cleanupIdleCheck();
      }
      this.wss.close();
    }

    logger.info('World server stopped');
  }
}
