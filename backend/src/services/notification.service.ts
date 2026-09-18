/**
 * User-facing notifications: persisted so nothing is lost while a client is
 * offline, and pushed over the socket for anyone currently connected.
 */

import { Notification } from '../models/index.js';
import { logger } from '../config/logger.js';
import { realtime } from './realtime.service.js';
import type { NotificationEvent } from '@sas/shared';

export interface NotifyInput {
  userId: string;
  level: NotificationEvent['level'];
  title: string;
  body?: string;
  requestId?: string;
}

export async function notifyUser(input: NotifyInput): Promise<void> {
  try {
    const saved = await Notification.create({
      user: input.userId,
      level: input.level,
      title: input.title,
      body: input.body,
      request: input.requestId ?? null,
    });

    realtime.notify(input.userId, {
      id: saved._id.toString(),
      level: input.level,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      at: saved.createdAt.toISOString(),
    });
  } catch (error) {
    // A missed notification must not abort a dispatch in progress.
    logger.error({ err: error, userId: input.userId }, 'Failed to deliver notification');
  }
}
