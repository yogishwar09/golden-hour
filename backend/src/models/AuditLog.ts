import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * An append-only record of every consequential action.
 *
 * Healthcare dispatch has to be reconstructable after the fact: who dispatched
 * which vehicle, who cancelled a case, who changed a bed count. Reads are rare,
 * writes are frequent and must never block the request they describe.
 */
export interface AuditLogAttrs {
  actor?: Types.ObjectId | null;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogAttrs>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: String, index: true },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });

export const AuditLog = model<AuditLogAttrs, Model<AuditLogAttrs>>('AuditLog', auditLogSchema);
