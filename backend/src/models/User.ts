import bcrypt from 'bcryptjs';
import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { BLOOD_GROUPS, ROLES, type BloodGroup, type Role, type UserDto } from '@sas/shared';

export interface UserAttrs {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: Role;
  bloodGroup: BloodGroup;
  emergencyContact?: { name: string; phone: string };
  medicalNotes?: string;
  /** Last known position of the account holder, used to prefill an SOS. */
  lastLocation?: { type: 'Point'; coordinates: [number, number] };
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMethods {
  verifyPassword(plain: string): Promise<boolean>;
  toDto(): UserDto;
}

export type UserDocument = HydratedDocument<UserAttrs, UserMethods>;
type UserModel = Model<UserAttrs, Record<string, never>, UserMethods>;

/** Cost factor for bcrypt. 12 is the current sensible default for an API. */
const BCRYPT_ROUNDS = 12;

const userSchema = new Schema<UserAttrs, UserModel, UserMethods>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true },
    // `select: false` keeps the hash out of every query result unless a caller
    // explicitly asks for it, which only the login path does.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'patient', index: true },
    bloodGroup: { type: String, enum: BLOOD_GROUPS, default: 'UNKNOWN' },
    emergencyContact: {
      type: new Schema({ name: String, phone: String }, { _id: false }),
      required: false,
    },
    medicalNotes: { type: String, maxlength: 1000 },
    lastLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ lastLocation: '2dsphere' });

userSchema.method('verifyPassword', function verifyPassword(plain: string): Promise<boolean> {
  return bcrypt.compare(plain, this.passwordHash);
});

userSchema.method('toDto', function toDto(): UserDto {
  return {
    id: (this._id as Types.ObjectId).toString(),
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    bloodGroup: this.bloodGroup,
    ...(this.emergencyContact
      ? {
          emergencyContact: {
            name: this.emergencyContact.name,
            phone: this.emergencyContact.phone,
          },
        }
      : {}),
    ...(this.medicalNotes ? { medicalNotes: this.medicalNotes } : {}),
    createdAt: this.createdAt.toISOString(),
  };
});

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export const User = model<UserAttrs, UserModel>('User', userSchema);
