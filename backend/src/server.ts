/**
 * Process entry point: connect the database, start HTTP and the socket server,
 * and shut both down cleanly on a signal.
 */

import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { createApp } from './app.js';
import { closeSocketServer, createSocketServer } from './sockets/index.js';
import { clearAllOfferTimers } from './services/dispatch.service.js';

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(env.PORT, env.HOST, resolve);
  });

  logger.info(
    { port: env.PORT, env: env.NODE_ENV, routing: env.ROUTING_ENABLED ? 'osrm' : 'offline' },
    `Smart Ambulance API listening on http://localhost:${env.PORT}`,
  );

  let shuttingDown = false;

  /**
   * Graceful shutdown. Existing requests are allowed to finish; a hard exit
   * follows if they do not, so a stuck connection cannot block a deploy.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; exiting immediately');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      clearAllOfferTimers();
      await closeSocketServer(io);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await disconnectDatabase();
      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means the process is in an unknown state. Log it
  // loudly and let the platform restart a clean one.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the server');
  process.exit(1);
});
