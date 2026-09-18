/**
 * Audit logging.
 *
 * Deliberately fire-and-forget: an audit write must never delay or fail the
 * operation it records. A failure to log is logged, not thrown.
 */

import { AuditLog } from '../models/index.js';
import { logger } from '../config/logger.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

export function recordAudit(input: AuditInput): void {
  void AuditLog.create({
    actor: input.actorId ?? null,
    actorRole: input.actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: input.meta,
    ip: input.ip,
  }).catch((error: unknown) => {
    logger.error({ err: error, action: input.action }, 'Failed to write audit log');
  });
}
