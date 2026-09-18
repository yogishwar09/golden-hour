/**
 * Bearer-token authentication.
 *
 * The token carries only an id and a role. Every request re-reads the user, so
 * a deactivated account or a changed role takes effect on the next request
 * rather than whenever the token happens to expire.
 */

import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@sas/shared';
import { env } from '../config/env.js';
import { User, type UserDocument } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export interface TokenPayload {
  sub: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; present on every protected handler. */
      user?: UserDocument;
    }
  }
}

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ sub: userId, role } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_TTL_SECONDS,
    issuer: 'smart-ambulance',
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: 'smart-ambulance' });
    if (typeof decoded === 'string' || !decoded.sub) throw new Error('Malformed token');
    return { sub: String(decoded.sub), role: (decoded as TokenPayload).role };
  } catch {
    // The reason is deliberately not echoed back: whether a token is expired or
    // forged is not information an unauthenticated caller needs.
    throw ApiError.unauthorized('Your session is invalid or has expired');
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Sign in to continue');

  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw ApiError.unauthorized('This account is no longer active');

  req.user = user;
  next();
});

/** Attaches the user when a token is present, but never rejects. */
export const optionalAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        const user = await User.findById(payload.sub);
        if (user?.isActive) req.user = user;
      } catch {
        // An unreadable token on an optional route is simply an anonymous call.
      }
    }
    next();
  },
);

/** Restricts a route to the given roles. Must run after `requireAuth`. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`This action requires the ${roles.join(' or ')} role`));
    }
    next();
  };
}
