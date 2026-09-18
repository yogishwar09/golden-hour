import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { toLatLng, type HospitalDto } from '@sas/shared';

export interface HospitalAttrs {
  name: string;
  address: string;
  phone: string;
  location: { type: 'Point'; coordinates: [number, number] };
  /** 1 is the most capable; mirrors the ACS trauma-centre levels. */
  traumaLevel: number;
  specialties: string[];
  beds: { total: number; available: number };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface HospitalMethods {
  toDto(distanceMetres?: number): HospitalDto;
}

export type HospitalDocument = HydratedDocument<HospitalAttrs, HospitalMethods>;
type HospitalModel = Model<HospitalAttrs, Record<string, never>, HospitalMethods>;

const hospitalSchema = new Schema<HospitalAttrs, HospitalModel, HospitalMethods>(
  {
    name: { type: String, required: true, trim: true, index: true },
    address: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    location: {
      type: { type: String, enum: ['Point'], required: true, default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    traumaLevel: { type: Number, min: 1, max: 4, default: 3 },
    specialties: { type: [String], default: [] },
    beds: {
      total: { type: Number, min: 0, default: 0 },
      available: { type: Number, min: 0, default: 0 },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

hospitalSchema.index({ location: '2dsphere' });

hospitalSchema.method('toDto', function toDto(distanceMetres?: number): HospitalDto {
  return {
    id: (this._id as Types.ObjectId).toString(),
    name: this.name,
    address: this.address,
    phone: this.phone,
    location: toLatLng(this.location) ?? { lat: 0, lng: 0 },
    traumaLevel: this.traumaLevel,
    specialties: this.specialties,
    beds: { total: this.beds.total, available: this.beds.available },
    ...(distanceMetres === undefined ? {} : { distanceMetres: Math.round(distanceMetres) }),
  };
});

export const Hospital = model<HospitalAttrs, HospitalModel>('Hospital', hospitalSchema);
