/**
 * Environment loading and validation.
 *
 * The process refuses to start on an invalid configuration rather than failing
 * later in a request handler, and it refuses to start in production with the
 * development JWT secret still in place.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both `src/config` under tsx and `dist/config` after a build.
loadDotenv({ path: path.resolve(here, '../../.env') });

const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me-in-production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  /**
   * A MongoDB connection string. When omitted outside production the server
   * starts a throwaway in-memory MongoDB so the stack runs with no setup.
   */
  MONGO_URI: z.string().trim().min(1).optional(),
  MONGO_DB_NAME: z.string().trim().default('smart_ambulance'),

  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  /** Access-token lifetime in seconds. */
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(60 * 60 * 12),

  /** Comma-separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  /** Public OSRM instance by default; point this at your own for production. */
  OSRM_BASE_URL: z.string().url().default('https://router.project-osrm.org'),
  ROUTING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Milliseconds before a routing call is abandoned for the offline estimate. */
  ROUTING_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(4000),

  /** How long a crew has to accept an offer before it moves to the next crew. */
  DISPATCH_OFFER_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(25),
  /** Search radius for the first dispatch pass, in kilometres. */
  DISPATCH_SEARCH_RADIUS_KM: z.coerce.number().min(1).max(200).default(15),
  /** Radius for the widened second pass when the first finds nothing. */
  DISPATCH_MAX_RADIUS_KM: z.coerce.number().min(1).max(500).default(40),
  /** Vehicles to try, in order, before declaring no ambulance available. */
  DISPATCH_MAX_CANDIDATES: z.coerce.number().int().min(1).max(20).default(5),

  /** Requests per window per IP for general API traffic. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  /** A much tighter budget for the SOS endpoint. */
  SOS_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(6),
  /**
   * Sign-in attempts per IP per 15 minutes. The default is deliberately tight,
   * because unlimited attempts invite credential stuffing. A demonstration
   * deployment whose fleet is driven by the simulator raises it, since a
   * hundred-odd crews signing in from one address is legitimate there.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(5).default(20),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Seed script password for the demo accounts it creates. */
  SEED_PASSWORD: z.string().min(8).default('Password123'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

if (env.isProduction) {
  if (env.JWT_SECRET === DEV_JWT_SECRET) {
    throw new Error('JWT_SECRET must be set to a strong unique value in production.');
  }
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI must be set in production; the in-memory database is dev-only.');
  }
}

export type Env = typeof env;
