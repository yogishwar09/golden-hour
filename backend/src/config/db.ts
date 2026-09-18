/**
 * Database connection management.
 *
 * Production points `MONGO_URI` at Atlas or any MongoDB deployment. With no URI
 * configured -- a fresh clone, or CI -- the server manages a local MongoDB for
 * you, so `npm run dev` works on a machine with nothing installed.
 *
 * That managed instance is deliberately *persistent and shared*: it stores its
 * files under `backend/.local-db` and listens on a fixed port, so seeding in one
 * terminal and running the server in another see the same data, and restarting
 * the server does not wipe the fleet. The first process to need it starts it;
 * every later process connects to the one already running.
 */

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

/** Deliberately not 27017, so a developer's own mongod is never touched. */
const LOCAL_PORT = 27027;
const LOCAL_HOST = '127.0.0.1';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DB_PATH = path.resolve(here, '../../.local-db');

/** Held so the process that started the instance can stop it on shutdown. */
let managedInstance: { stop: () => Promise<boolean | void> } | null = null;

/** True when something is already accepting connections on the local port. */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Waits for the local port to become free.
 *
 * A MongoDB that is shutting down still holds its port for a moment. Starting a
 * replacement before it lets go fails to bind, so we give the old one a chance
 * to finish before taking over.
 */
async function waitForPortFree(port: number, host: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port, host))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const CONNECT_OPTIONS = {
  dbName: env.MONGO_DB_NAME,
  // Fail fast rather than queueing requests behind an unreachable cluster.
  serverSelectionTimeoutMS: 10_000,
  maxPoolSize: 20,
  retryWrites: true,
} as const;

/** Attempts a connection, reporting failure instead of throwing. */
async function tryConnect(uri: string): Promise<boolean> {
  try {
    await mongoose.connect(uri, CONNECT_OPTIONS);
    return true;
  } catch (error) {
    logger.debug({ err: error }, 'Connection attempt failed');
    return false;
  }
}

/** Starts a MongoDB this process owns, storing its data under `.local-db`. */
async function startManagedMongo(): Promise<string> {
  await mkdir(LOCAL_DB_PATH, { recursive: true });

  // Imported lazily: this is a dev dependency and is never present in a
  // production image, where MONGO_URI is always configured.
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const server = await MongoMemoryServer.create({
    instance: {
      port: LOCAL_PORT,
      ip: LOCAL_HOST,
      dbName: env.MONGO_DB_NAME,
      // Storing to disk is what makes `npm run seed` in one terminal visible to
      // `npm run dev` in another.
      dbPath: LOCAL_DB_PATH,
      storageEngine: 'wiredTiger',
    },
  });
  managedInstance = server;
  return server.getUri(env.MONGO_DB_NAME);
}

/**
 * Connection-independent Mongoose settings.
 *
 * Exported so the test harness applies exactly the same configuration as the
 * server: a setting that only ever runs in production is a setting no test can
 * catch.
 *
 * Note on query-injection safety: `sanitizeFilter` is deliberately *not*
 * enabled. It wraps every operator object it sees in `$eq`, which silently
 * breaks legitimate `$nin`, `$gt` and `$nearSphere` filters written in
 * application code. Injection is prevented at the edge instead -- every value
 * that reaches a query has been through a Zod schema that yields a primitive,
 * so an attacker cannot smuggle an operator object into a filter.
 */
export function configureMongoose(): void {
  // Reject queries against fields that are not in the schema, rather than
  // silently ignoring the condition and matching far more documents.
  mongoose.set('strictQuery', true);
}

function attachConnectionListeners(): void {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (error) => logger.error({ err: error }, 'MongoDB error'));
}

/**
 * Geospatial dispatch is only correct once the 2dsphere indexes exist, so they
 * are built before the server starts accepting traffic.
 */
async function syncIndexes(): Promise<void> {
  await mongoose.connection.syncIndexes({ continueOnError: true }).catch((error: unknown) => {
    logger.warn({ err: error }, 'Index sync reported a problem');
  });
}

export async function connectDatabase(): Promise<typeof mongoose> {
  configureMongoose();
  attachConnectionListeners();

  // Production and any explicitly configured database: connect or fail loudly.
  // There is deliberately no fallback here -- silently starting a throwaway
  // database when Atlas is unreachable would hide a real outage behind an
  // empty, working-looking API.
  if (env.MONGO_URI) {
    await mongoose.connect(env.MONGO_URI, CONNECT_OPTIONS);
    await syncIndexes();
    return mongoose;
  }

  const localUri = `mongodb://${LOCAL_HOST}:${LOCAL_PORT}/${env.MONGO_DB_NAME}`;

  // Prefer a local MongoDB that is already running -- that is what lets the
  // seed script and the dev server share one database. But an open port is not
  // proof of a working server: it may be one that is shutting down. So the
  // connection is verified, and we start our own if it does not hold up.
  if (await isPortInUse(LOCAL_PORT, LOCAL_HOST)) {
    if (await tryConnect(localUri)) {
      logger.info(`Using the local development MongoDB already running on port ${LOCAL_PORT}`);
      await syncIndexes();
      return mongoose;
    }
    logger.warn(
      `Port ${LOCAL_PORT} was open but MongoDB did not respond; waiting for it to release the port.`,
    );
    await waitForPortFree(LOCAL_PORT, LOCAL_HOST);
  }

  logger.warn(
    'MONGO_URI is not set - starting a local development MongoDB (data is kept in backend/.local-db).',
  );
  await mongoose.connect(await startManagedMongo(), CONNECT_OPTIONS);
  await syncIndexes();
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
  if (managedInstance) {
    await managedInstance.stop();
    managedInstance = null;
  }
}

export type DatabaseState = 'disconnected' | 'connected' | 'connecting' | 'disconnecting';

export function databaseState(): DatabaseState {
  // Mongoose also uses 99 for "uninitialized", which is not in this list.
  const states: Record<number, DatabaseState> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[mongoose.connection.readyState] ?? 'disconnected';
}
