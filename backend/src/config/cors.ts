/**
 * Which browser origins may call this API.
 *
 * Production uses the explicit `CORS_ORIGINS` allowlist and nothing else.
 *
 * Development is deliberately more permissive about localhost. Vite picks the
 * next free port when its default is taken (5173 -> 5174 -> ...), and the only
 * symptom of that drift is a CORS rejection on the sign-in screen, far from the
 * cause. A developer's own machine is not a security boundary, so any localhost
 * origin is accepted there -- and only there.
 */

import { env } from './env.js';

/** `http://localhost:5174`, `http://127.0.0.1:3000`, `http://[::1]:8080`, ... */
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export function isOriginAllowed(origin: string): boolean {
  if (env.corsOrigins.includes(origin)) return true;
  if (!env.isProduction && LOCALHOST_ORIGIN.test(origin)) return true;
  return false;
}

/** The origins to report, for logging and diagnostics. */
export function describeAllowedOrigins(): string {
  const configured = env.corsOrigins.join(', ');
  return env.isProduction ? configured : `${configured} (plus any localhost origin in development)`;
}
