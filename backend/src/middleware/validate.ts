/**
 * Schema validation for request bodies, queries and params.
 *
 * The parsed result replaces the raw input, so handlers receive data that is
 * typed, trimmed and coerced, and can never see a field the schema did not
 * allow through.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ApiError } from '../utils/errors.js';

type Source = 'body' | 'query' | 'params';

function formatIssues(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export function validate<Schema extends ZodTypeAny>(schema: Schema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[source]) as z.infer<Schema>;
      if (source === 'query') {
        // `req.query` has only a getter on Express 5 and is read-only in some
        // setups, so the validated copy is stashed alongside it.
        Object.defineProperty(req, 'validatedQuery', { value: parsed, configurable: true });
      }
      Object.defineProperty(req, source, { value: parsed, configurable: true, writable: true });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(ApiError.badRequest('Some fields need attention', formatIssues(error)));
        return;
      }
      next(error);
    }
  };
}

/** Parses a payload outside the middleware chain (used by the socket layer). */
export function parseOrThrow<Schema extends ZodTypeAny>(
  schema: Schema,
  payload: unknown,
): z.infer<Schema> {
  try {
    return schema.parse(payload) as z.infer<Schema>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw ApiError.badRequest('Invalid payload', formatIssues(error));
    }
    throw error;
  }
}
