/**
 * The Express application.
 *
 * Kept separate from `server.ts` so tests can mount the app with `supertest`
 * without opening a port or starting the socket server.
 */

import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { isOriginAllowed } from './config/cors.js';
import { logger } from './config/logger.js';
import { databaseState } from './config/db.js';
import { apiRoutes } from './routes/index.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { ApiError } from './utils/errors.js';

export function createApp(): Express {
  const app = express();

  // Behind Render/Vercel/nginx the client IP arrives in X-Forwarded-For, and
  // rate limiting is keyed on it. `1` trusts exactly one proxy hop rather than
  // any header the internet sends.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON to a separately hosted SPA, so a page-oriented CSP
      // would do nothing here; the front end ships its own.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: a server-to-server call, curl, or a health probe.
        if (!origin) return callback(null, true);
        if (isOriginAllowed(origin)) return callback(null, true);
        // An ApiError rather than a bare Error, so a disallowed origin is
        // reported as the 403 it is instead of looking like a server fault.
        callback(ApiError.forbidden(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );

  app.use(compression());
  // A hard cap: an emergency payload is a few hundred bytes, so anything
  // larger is a mistake or an attack.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Liveness: the process is up. Deliberately does not touch the database, so
  // an orchestrator does not restart a healthy API during a brief DB blip.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  // Readiness: the API can actually serve traffic.
  //
  // `readyState` alone, deliberately. An earlier version also pinged the
  // database when the state looked wrong, out of a worry that an idle
  // connection would fail the probe and have an orchestrator pull a healthy
  // instance. Measured over a minute of sampling, the state reads `connected`
  // on every probe: idle drops resolve long before a probe observes them, and
  // a readiness probe needs several consecutive failures to act anyway.
  app.get('/api/ready', (_req, res) => {
    const database = databaseState();
    const ready = database === 'connected';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', database });
  });

  app.use('/api', apiLimiter, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
