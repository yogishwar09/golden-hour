import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Persisted notifications, so a user who was offline (or whose socket dropped
 * mid-incident) still sees what happened when they come back.
 */
export interface NotificationAttrs {
  user: Types.ObjectId;
  level: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body?: string;
  request?: Types.ObjectId | null;
  readAt?: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationAttrs>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    level: { type: String, enum: ['info', 'success', 'warning', 'critical'], default: 'info' },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, maxlength: 500 },
    request: { type: Schema.Types.ObjectId, ref: 'EmergencyRequest', default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = model<NotificationAttrs, Model<NotificationAttrs>>(
  'Notification',
  notificationSchema,
);
