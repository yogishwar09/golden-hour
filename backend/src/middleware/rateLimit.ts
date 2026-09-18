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

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // The limiter would otherwise make the whole test suite flaky.
  skip: () => env.isTest,
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
  limit: 20,
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
