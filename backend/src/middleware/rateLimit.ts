/**
 * Rate limiting.
 *
 * Two budgets: a generous one for ordinary API traffic, and a deliberately
 * tight one for the SOS endpoint and the auth endpoints, which are the two
 * places abuse actually costs something -- a flood of fake emergencies ties up
 * real vehicles, and unlimited login attempts invite credential stuffing.
 */

import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * Loopback addresses, in the forms Node reports them.
 *
 * Traffic from the machine itself is exempt from rate limiting in development
 * only. The fleet simulator signs in as every crew at once, which from one
 * address is indistinguishable from credential stuffing -- and being throttled
 * left most of the fleet with nobody driving it. A developer's own machine is
 * not the threat these limits exist for. In production every request is
 * counted, wherever it came from.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isExempt(req: Request): boolean {
  if (env.isTest) return true;
  if (env.isProduction) return false;
  return LOOPBACK.has(req.ip ?? '');
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // The limiter would otherwise make the whole test suite flaky, and would
  // throttle the simulator's fleet-wide sign-in during development.
  skip: isExempt,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
};

export const apiLimiter = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
});

export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    },
  },
});

/**
 * Keyed by user rather than IP: several genuine callers can share one mobile
 * network address, and it is a specific account raising repeat false alarms
 * that we want to slow down.
 */
export const sosLimiter = rateLimit({
  ...shared,
  windowMs: 10 * 60 * 1000,
  limit: env.SOS_RATE_LIMIT_MAX,
  keyGenerator: (req: Request) => req.user?._id.toString() ?? req.ip ?? 'anonymous',
  message: {
    error: {
      code: 'RATE_LIMITED',
      message:
        'Several emergency requests have been raised from this account recently. ' +
        'If this is a genuine emergency, call your local emergency number now.',
    },
  },
});
