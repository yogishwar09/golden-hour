import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import {
  AMBULANCE_STATUSES,
  AMBULANCE_TYPES,
  toLatLng,
  type AmbulanceDto,
  type AmbulanceStatus,
  type AmbulanceType,
} from '@sas/shared';

export interface AmbulanceAttrs {
  vehicleNumber: string;
  type: AmbulanceType;
  status: AmbulanceStatus;
  driver: Types.ObjectId;
  hospital: Types.ObjectId;
  crew: Array<{ name: string; role: string }>;
  equipment: string[];
  /** Where the vehicle parks when idle; also its position while offline. */
  baseLocation: { type: 'Point'; coordinates: [number, number] };
  location: { type: 'Point'; coordinates: [number, number] };
  heading: number;
  speedMps: number;
  lastSeenAt?: Date;
  /** The case this vehicle is currently committed to, if any. */
  activeRequest?: Types.ObjectId | null;
  /** Set while an offer is outstanding, so a second case cannot double-book it. */
  offerExpiresAt?: Date | null;
  isActive: boolean;
  /** Lifetime counters, cheap to maintain and useful for fleet reporting. */
  stats: { completedTrips: number; cancelledTrips: number; declinedOffers: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface AmbulanceMethods {
  toDto(distanceMetres?: number): AmbulanceDto;
}

export type AmbulanceDocument = HydratedDocument<AmbulanceAttrs, AmbulanceMethods>;
type AmbulanceModel = Model<AmbulanceAttrs, Record<string, never>, AmbulanceMethods>;

const ambulanceSchema = new Schema<AmbulanceAttrs, AmbulanceModel, AmbulanceMethods>(
  {
    vehicleNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: AMBULANCE_TYPES, required: true, index: true },
    status: { type: String, enum: AMBULANCE_STATUSES, default: 'OFFLINE', index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hospital: { type: Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    crew: { type: [new Schema({ name: String, role: String }, { _id: false })], default: [] },
    equipment: { type: [String], default: [] },
    baseLocation: {
      type: { type: String, enum: ['Point'], required: true, default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    location: {
      type: { type: String, enum: ['Point'], required: true, default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    heading: { type: Number, min: 0, max: 360, default: 0 },
    speedMps: { type: Number, min: 0, default: 0 },
    lastSeenAt: { type: Date },
    activeRequest: { type: Schema.Types.ObjectId, ref: 'EmergencyRequest', default: null },
    offerExpiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    stats: {
      completedTrips: { type: Number, default: 0 },
      cancelledTrips: { type: Number, default: 0 },
      declinedOffers: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// The dispatcher's hot path is "nearest available vehicle of at least type X",
// so the geo index carries status and type as trailing keys.
ambulanceSchema.index({ location: '2dsphere', status: 1, type: 1 });

ambulanceSchema.method('toDto', function toDto(distanceMetres?: number): AmbulanceDto {
  // `driver` and `hospital` are only expanded when the query populated them.
  const driver = this.populated('driver')
    ? (this.driver as unknown as { _id: Types.ObjectId; name: string; phone: string })
    : null;
  const hospital = this.populated('hospital')
    ? (this.hospital as unknown as { _id: Types.ObjectId; name: string })
    : null;

  return {
    id: (this._id as Types.ObjectId).toString(),
    vehicleNumber: this.vehicleNumber,
    type: this.type,
    status: this.status,
    location: toLatLng(this.location),
    heading: this.heading,
    speedMps: this.speedMps,
    crew: this.crew.map((member) => ({ name: member.name, role: member.role })),
    equipment: this.equipment,
    ...(driver
      ? { driver: { id: driver._id.toString(), name: driver.name, phone: driver.phone } }
      : {}),
    ...(hospital ? { hospital: { id: hospital._id.toString(), name: hospital.name } } : {}),
    activeRequestId: this.activeRequest ? this.activeRequest.toString() : null,
    lastSeenAt: this.lastSeenAt ? this.lastSeenAt.toISOString() : null,
    ...(distanceMetres === undefined ? {} : { distanceMetres: Math.round(distanceMetres) }),
  };
});

export const Ambulance = model<AmbulanceAttrs, AmbulanceModel>('Ambulance', ambulanceSchema);
