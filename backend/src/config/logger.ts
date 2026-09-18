import pino from 'pino';
import { env } from './env.js';

/**
 * Structured logging. Pretty and colourised while developing, newline-delimited
 * JSON in production so a log shipper can parse it.
 *
 * `redact` is the important part: request bodies flow through the HTTP logger
 * and must never carry a password or a bearer token into the log store.
 */
export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'body.password',
      'password',
      'passwordHash',
      'accessToken',
      'token',
    ],
    censor: '[redacted]',
  },
  transport:
    env.isProduction || env.isTest
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
});

export type Logger = typeof logger;
