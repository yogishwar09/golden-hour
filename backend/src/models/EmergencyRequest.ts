import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import {
  AMBULANCE_TYPES,
  BLOOD_GROUPS,
  EMERGENCY_TYPES,
  PRIORITIES,
  REQUEST_STATUSES,
  type AmbulanceType,
  type BloodGroup,
  type EmergencyType,
  type Priority,
  type RequestStatus,
  type RouteDto,
} from '@sas/shared';

/** One entry per state change, giving each case a complete audit trail. */
export interface TimelineEntry {
  status: RequestStatus;
  at: Date;
  note?: string;
  by?: string;
}

/** A vehicle the dispatcher offered this case to, and what came of it. */
export interface DispatchAttempt {
  ambulance: Types.ObjectId;
  offeredAt: Date;
  respondedAt?: Date;
  outcome: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT' | 'SUPERSEDED';
  reason?: string;
  distanceMetres: number;
  etaSeconds: number;
}

export interface EmergencyRequestAttrs {
  code: string;
  status: RequestStatus;
  priority: Priority;
  emergencyType: EmergencyType;
  triageReasons: string[];
  requiredAmbulanceType: AmbulanceType;
  pickup: { type: 'Point'; coordinates: [number, number] };
  pickupAddress?: string;
  notes?: string;
  contactPhone?: string;
  patient: Types.ObjectId;
  /**
   * The patient's details as they were at the time of the call. Copied rather
   * than looked up so the crew sees what was true during the incident even if
   * the profile changes later.
   */
  patientSnapshot: { name: string; phone: string; bloodGroup: BloodGroup; medicalNotes?: string };
  ambulance?: Types.ObjectId | null;
  hospital?: Types.ObjectId | null;
  preferredHospital?: Types.ObjectId | null;
  route?: RouteDto | null;
  etaSeconds?: number | null;
  etaUpdatedAt?: Date | null;
  timeline: TimelineEntry[];
  dispatchAttempts: DispatchAttempt[];
  assignedAt?: Date | null;
  onSceneAt?: Date | null;
  completedAt?: Date | null;
  /** Seconds from SOS to the crew arriving, the headline response metric. */
  responseSeconds?: number | null;
  cancellationReason?: string;
  cancelledBy?: Types.ObjectId | null;
  rating?: { stars: number; comment?: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EmergencyRequestDocument = HydratedDocument<EmergencyRequestAttrs>;
type EmergencyRequestModel = Model<EmergencyRequestAttrs>;

const timelineSchema = new Schema<TimelineEntry>(
  {
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String, maxlength: 500 },
    by: { type: String, maxlength: 120 },
  },
  { _id: false },
);

const dispatchAttemptSchema = new Schema<DispatchAttempt>(
  {
    ambulance: { type: Schema.Types.ObjectId, ref: 'Ambulance', required: true },
    offeredAt: { type: Date, required: true, default: Date.now },
    respondedAt: { type: Date },
    outcome: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'SUPERSEDED'],
      default: 'PENDING',
    },
    reason: { type: String, maxlength: 200 },
    distanceMetres: { type: Number, default: 0 },
    etaSeconds: { type: Number, default: 0 },
  },
  { _id: false },
);

const routeSchema = new Schema<RouteDto>(
  {
    points: {
      type: [new Schema({ lat: Number, lng: Number }, { _id: false })],
      default: [],
    },
    distanceMetres: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    source: { type: String, enum: ['osrm', 'straight-line'], default: 'straight-line' },
  },
  { _id: false },
);

const emergencyRequestSchema = new Schema<EmergencyRequestAttrs, EmergencyRequestModel>(
  {
    code: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: REQUEST_STATUSES, default: 'PENDING', index: true },
    priority: { type: String, enum: PRIORITIES, default: 'P3', index: true },
    emergencyType: { type: String, enum: EMERGENCY_TYPES, default: 'OTHER' },
    triageReasons: { type: [String], default: [] },
    requiredAmbulanceType: { type: String, enum: AMBULANCE_TYPES, default: 'BLS' },
    pickup: {
      type: { type: String, enum: ['Point'], required: true, default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    pickupAddress: { type: String, maxlength: 300 },
    notes: { type: String, maxlength: 1000 },
    contactPhone: { type: String, maxlength: 20 },
    patient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    patientSnapshot: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      bloodGroup: { type: String, enum: BLOOD_GROUPS, default: 'UNKNOWN' },
      medicalNotes: { type: String, maxlength: 1000 },
    },
    ambulance: { type: Schema.Types.ObjectId, ref: 'Ambulance', default: null, index: true },
    hospital: { type: Schema.Types.ObjectId, ref: 'Hospital', default: null, index: true },
    preferredHospital: { type: Schema.Types.ObjectId, ref: 'Hospital', default: null },
    route: { type: routeSchema, default: null },
    etaSeconds: { type: Number, default: null },
    etaUpdatedAt: { type: Date, default: null },
    timeline: { type: [timelineSchema], default: [] },
    dispatchAttempts: { type: [dispatchAttemptSchema], default: [] },
    assignedAt: { type: Date, default: null },
    onSceneAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    responseSeconds: { type: Number, default: null },
    cancellationReason: { type: String, maxlength: 300 },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rating: {
      type: new Schema({ stars: Number, comment: String }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true },
);

emergencyRequestSchema.index({ pickup: '2dsphere' });
// The control room lists live cases newest-first; the patient lists their own.
emergencyRequestSchema.index({ status: 1, createdAt: -1 });
emergencyRequestSchema.index({ patient: 1, createdAt: -1 });

export const EmergencyRequest = model<EmergencyRequestAttrs, EmergencyRequestModel>(
  'EmergencyRequest',
  emergencyRequestSchema,
);

/**
 * Short, unambiguous case reference a caller can read over the phone.
 * Excludes characters that are easy to mishear (0/O, 1/I, 5/S).
 */
const CODE_ALPHABET = '23456789ACDEFGHJKLMNPQRTUVWXYZ';

export function generateRequestCode(): string {
  let suffix = '';
  for (let index = 0; index < 5; index += 1) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `SAS-${suffix}`;
}
