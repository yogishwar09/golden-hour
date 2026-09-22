/**
 * Database connection management.
 *
 * Three ways to get a database, tried in order:
 *
 *   1. `MONGO_URI`     - production, Atlas, or any explicitly chosen server.
 *   2. localhost:27017 - a MongoDB the developer already runs. Preferred in
 *                        development because nothing in this project owns it,
 *                        so no process of ours can take it away from another.
 *   3. A managed server on port 27027, storing to `backend/.local-db`, started
 *                        on demand for machines with no MongoDB installed.
 *
 * Why the ordering matters
 * ------------------------
 * Option 3 used to be the only fallback, and it had a sharp edge: `tsx watch`
 * restarts the API on every edit, and the restarting process would adopt the
 * outgoing process's managed server (its port was still open) moments before
 * that process shut the server down -- leaving a live API attached to a dead
 * database, retrying forever. Preferring a server nobody owns removes the
 * ownership question entirely, and the watchdog below recovers the case where
 * a development database disappears anyway.
 */

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

/** The conventional MongoDB port, where a developer's own server would be. */
const LOCAL_MONGOD_PORT = 27017;
/** Ours, deliberately not 27017 so we never fight with the above. */
const MANAGED_PORT = 27027;
const HOST = '127.0.0.1';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DB_PATH = path.resolve(here, '../../.local-db');

/** Set only when this process started the managed server, so only its owner stops it. */
let managedInstance: { stop: () => Promise<boolean | void> } | null = null;

/** True once a deliberate shutdown begins, so the watchdog stops interfering. */
let shuttingDown = false;
let watchdogTimer: NodeJS.Timeout | null = null;

const CONNECT_OPTIONS = {
  dbName: env.MONGO_DB_NAME,
  // Fail fast rather than queueing requests behind an unreachable cluster.
  serverSelectionTimeoutMS: 10_000,
  maxPoolSize: 20,
  retryWrites: true,
} as const;

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

/** True when something is accepting TCP connections on a port. */
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
 * Waits for a port to become free. A MongoDB that is shutting down still holds
 * its port briefly, and starting a replacement before it lets go fails to bind.
 */
async function waitForPortFree(port: number, host: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port, host))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Attempts a connection, reporting failure instead of throwing. */
async function tryConnect(uri: string): Promise<boolean> {
  try {
    await mongoose.connect(uri, CONNECT_OPTIONS);
    return true;
  } catch (error) {
    logger.debug({ err: error, uri }, 'Connection attempt failed');
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
      port: MANAGED_PORT,
      ip: HOST,
      dbName: env.MONGO_DB_NAME,
      // Storing to disk is what lets `npm run seed` in one terminal be visible
      // to `npm run dev` in another.
      dbPath: LOCAL_DB_PATH,
      storageEngine: 'wiredTiger',
    },
  });
  managedInstance = server;
  return server.getUri(env.MONGO_DB_NAME);
}

/**
 * Finds a database and connects to it. Throws only when an explicitly
 * configured `MONGO_URI` is unreachable -- that is a real outage, and starting
 * a throwaway database in its place would hide it behind an empty,
 * working-looking API.
 */
async function resolveAndConnect(): Promise<'configured' | 'local' | 'managed'> {
  if (env.MONGO_URI) {
    await mongoose.connect(env.MONGO_URI, CONNECT_OPTIONS);
    return 'configured';
  }

  if (await isPortInUse(LOCAL_MONGOD_PORT, HOST)) {
    const uri = `mongodb://${HOST}:${LOCAL_MONGOD_PORT}/${env.MONGO_DB_NAME}`;
    if (await tryConnect(uri)) {
      logger.info(`Using the MongoDB already running on port ${LOCAL_MONGOD_PORT}`);
      return 'local';
    }
  }

  // An open port is not proof of a working server -- it may be one that is
  // shutting down -- so the connection is verified before being trusted.
  if (await isPortInUse(MANAGED_PORT, HOST)) {
    const uri = `mongodb://${HOST}:${MANAGED_PORT}/${env.MONGO_DB_NAME}`;
    if (await tryConnect(uri)) {
      logger.info(`Using the managed development MongoDB on port ${MANAGED_PORT}`);
      return 'managed';
    }
    logger.warn(
      `Port ${MANAGED_PORT} was open but MongoDB did not answer; waiting for it to close.`,
    );
    await waitForPortFree(MANAGED_PORT, HOST);
  }

  logger.warn(
    'No MongoDB found - starting a managed one (data is kept in backend/.local-db). ' +
      'Set MONGO_URI, or run your own mongod, to use a different database.',
  );
  await mongoose.connect(await startManagedMongo(), CONNECT_OPTIONS);
  return 'managed';
}

/**
 * Reports a database that has genuinely stopped answering.
 *
 * Deliberately reports and does nothing else. An earlier version tried to
 * *recover* -- force-closing the connection and resolving a new database after
 * eight seconds. That was wrong twice over: an idle MongoDB drops connections
 * routinely and the driver reconnects on its own, so the watchdog kept
 * interrupting a recovery already in progress; and `connection.close(true)`
 * leaves the connection object unusable, so every later query failed with
 * "Connection was force closed".
 *
 * The version after that was merely noisy: it trusted `readyState`, and so
 * logged an outage every time a quiet connection went idle -- around a hundred
 * false alarms in a day. It now asks the database before saying anything.
 *
 * The driver's own reconnection handles every case that actually occurs: a
 * transient drop, and a MongoDB that restarts. A server that is gone for good
 * needs a human, and this tells them so.
 */
function reportPersistentDisconnect(): void {
  if (env.isTest) return;

  const GRACE_MS = 30_000;

  mongoose.connection.on('disconnected', () => {
    if (shuttingDown || watchdogTimer) return;

    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (shuttingDown) return;

      void (async () => {
        // Ask the database, rather than reading `readyState`. MongoDB closes
        // idle connections and the driver reconnects on the next operation, so
        // a disconnected state with no traffic is normal and healthy. Reporting
        // it as an outage cried wolf roughly every fifteen minutes.
        if (await isDatabaseReachable()) {
          logger.debug('The connection went idle; the driver has it in hand.');
          return;
        }

        logger.error(
          'The database has been unreachable for 30 seconds. The driver is still retrying; ' +
            'if this persists, check that MongoDB is running and restart the server.',
        );
      })();
    }, GRACE_MS);
    watchdogTimer.unref?.();
  });
}

export type DatabaseState = 'disconnected' | 'connected' | 'connecting' | 'disconnecting';

/**
 * Whether the database will actually answer.
 *
 * A real command, not a state flag: the driver reconnects lazily, so the only
 * honest test of reachability is to ask it something. Used by the readiness
 * probe and by the disconnect reporting above.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return false;
    await admin.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the API should report itself ready, given a connection state.
 *
 * Takes the state as an argument rather than reading it, so the rule can be
 * tested without mocking the driver's internals. The rule itself: a state of
 * anything other than `connected` is a question, not an answer -- the driver
 * reconnects lazily, so an idle instance reads as disconnected while being
 * perfectly able to serve. Only a database that will not answer a command
 * makes an instance unready.
 */
export async function evaluateReadiness(state: DatabaseState): Promise<boolean> {
  if (state === 'connected') return true;
  return isDatabaseReachable();
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
  shuttingDown = false;
  configureMongoose();
  attachConnectionListeners();
  reportPersistentDisconnect();

  const source = await resolveAndConnect();
  await syncIndexes();
  logger.debug({ source }, 'Database ready');

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  shuttingDown = true;
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  await mongoose.connection.close();

  // Only the process that started the managed server stops it. A process that
  // merely connected to one must never shut it down for everybody else.
  if (managedInstance) {
    await managedInstance.stop();
    managedInstance = null;
  }
}

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
