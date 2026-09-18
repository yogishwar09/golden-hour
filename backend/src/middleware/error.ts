/**
 * The last link in the middleware chain.
 *
 * Deliberate failures (`ApiError`) are reported as they were thrown. Anything
 * else is a bug: it is logged with its stack and reported as a generic 500, so
 * a stack trace or a driver message never reaches a caller.
 */

import type { NextFunction, Request, Response } from 'express';
import { MongoServerError } from 'mongodb';
import { Error as MongooseError } from 'mongoose';
import type { ApiError as ApiErrorType } from '../utils/errors.js';
import { ApiError, isApiError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`No route matches ${req.method} ${req.path}`));
}

/**
 * Shape of the errors `body-parser` raises. It tags each one with a `type`,
 * which is how a malformed body is told apart from an oversized one.
 */
interface BodyParserError {
  type?: string;
  status?: number;
}

/** Maps framework and database failures onto the right HTTP status. */
function translate(error: unknown): ApiErrorType | null {
  if (isApiError(error)) return error;

  // Body-parser failures are the caller's mistake, not ours. Left untranslated
  // they surface as a 500, which both misleads the caller and fills the logs
  // with stack traces for what is ordinary malformed input.
  const bodyError = error as BodyParserError | null;
  if (bodyError?.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That request is too large.');
  }
  if (bodyError?.type === 'entity.parse.failed') {
    return ApiError.badRequest('The request body is not valid JSON.');
  }
  if (bodyError?.type === 'encoding.unsupported') {
    return ApiError.badRequest('That content encoding is not supported.');
  }

  if (error instanceof MongoServerError && error.code === 11000) {
    const field = Object.keys((error as { keyValue?: Record<string, unknown> }).keyValue ?? {})[0];
    return ApiError.conflict(
      field ? `That ${field} is already registered` : 'That record already exists',
    );
  }

  if (error instanceof MongooseError.ValidationError) {
    const details = Object.values(error.errors).map((issue) => ({
      field: issue.path,
      message: issue.message,
    }));
    return ApiError.badRequest('Some fields need attention', details);
  }

  if (error instanceof MongooseError.CastError) {
    return ApiError.badRequest(`'${String(error.value)}' is not a valid ${error.path}`);
  }

  return null;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the four-argument shape; if the response has already
  // started streaming there is nothing useful left to send.
  if (res.headersSent) {
    next(error);
    return;
  }

  const apiError = translate(error);

  if (apiError) {
    if (apiError.statusCode >= 500) {
      logger.error({ err: error, path: req.path }, apiError.message);
    } else {
      logger.debug({ code: apiError.code, path: req.path }, apiError.message);
    }

    res.status(apiError.statusCode).json({
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
      },
    });
    return;
  }

  logger.error({ err: error, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
      // The real message is useful while developing and dangerous in production.
      ...(env.isProduction ? {} : { details: String(error) }),
    },
  });
}
