/**
 * Request validation schemas.
 *
 * The server validates every inbound payload against these; the client imports
 * the same objects to validate forms before submitting. One definition, so the
 * two can never drift apart.
 */

import { z } from 'zod';
import {
  AMBULANCE_TYPES,
  BLOOD_GROUPS,
  EMERGENCY_TYPES,
  ROLES,
  AMBULANCE_STATUSES,
} from './enums.js';

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);

export const latLngSchema = z.object({ lat: latitude, lng: longitude });
export type LatLngInput = z.infer<typeof latLngSchema>;

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex id');

/** E.164-ish: an optional +, then 8-15 digits. Deliberately permissive. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9\s-]{7,18}$/, 'Enter a valid phone number');

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128)
  .regex(/[a-zA-Z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: phoneSchema,
  password: passwordSchema,
  role: z.enum(ROLES).default('patient'),
  bloodGroup: z.enum(BLOOD_GROUPS).default('UNKNOWN'),
  emergencyContact: z
    .object({ name: z.string().trim().min(2).max(80), phone: phoneSchema })
    .optional(),
  medicalNotes: z.string().trim().max(1000).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phoneSchema.optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  emergencyContact: z
    .object({ name: z.string().trim().min(2).max(80), phone: phoneSchema })
    .optional(),
  medicalNotes: z.string().trim().max(1000).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const reportedVitalsSchema = z.object({
  conscious: z.boolean().optional(),
  breathing: z.boolean().optional(),
  bleedingSeverely: z.boolean().optional(),
  victimCount: z.number().int().min(1).max(500).optional(),
  patientAgeYears: z.number().int().min(0).max(130).optional(),
});

export const createEmergencySchema = z.object({
  emergencyType: z.enum(EMERGENCY_TYPES).default('OTHER'),
  pickup: latLngSchema,
  pickupAddress: z.string().trim().max(300).optional(),
  /** Free-text detail from the caller, shown to the crew. */
  notes: z.string().trim().max(1000).optional(),
  vitals: reportedVitalsSchema.default({}),
  /** Caller-supplied contact, used when the SOS is raised for someone else. */
  contactPhone: phoneSchema.optional(),
  /** Optional preferred destination; the dispatcher picks one when omitted. */
  preferredHospitalId: objectIdSchema.optional(),
});
export type CreateEmergencyInput = z.infer<typeof createEmergencySchema>;

export const cancelEmergencySchema = z.object({
  reason: z.string().trim().min(3).max(300).default('Cancelled by caller'),
});

export const rateEmergencySchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});

export const locationPingSchema = z.object({
  lat: latitude,
  lng: longitude,
  /** Degrees clockwise from north; omitted when the device cannot supply it. */
  heading: z.number().min(0).max(360).optional(),
  /** Ground speed in metres per second. */
  speed: z.number().min(0).max(120).optional(),
  /** Reported GPS accuracy radius in metres. */
  accuracy: z.number().min(0).max(10_000).optional(),
});
export type LocationPingInput = z.infer<typeof locationPingSchema>;

export const offerResponseSchema = z.object({
  requestId: objectIdSchema,
  accept: z.boolean(),
  /** Optional reason when declining, kept for fleet quality reporting. */
  reason: z.string().trim().max(200).optional(),
});

export const advanceStatusSchema = z.object({
  requestId: objectIdSchema,
  /** The status the crew is moving the case into. */
  status: z.enum([
    'EN_ROUTE_TO_SCENE',
    'ON_SCENE',
    'TRANSPORTING',
    'ARRIVED_AT_HOSPITAL',
    'COMPLETED',
  ]),
  /** Chosen on the way out from the scene, when transport begins. */
  destinationHospitalId: objectIdSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

export const setDutyStatusSchema = z.object({
  status: z.enum(['OFFLINE', 'AVAILABLE', 'OUT_OF_SERVICE']),
});

export const createAmbulanceSchema = z.object({
  vehicleNumber: z.string().trim().min(3).max(20).toUpperCase(),
  type: z.enum(AMBULANCE_TYPES),
  driverId: objectIdSchema,
  hospitalId: objectIdSchema,
  crew: z
    .array(z.object({ name: z.string().trim().min(2).max(80), role: z.string().trim().max(40) }))
    .max(6)
    .default([]),
  equipment: z.array(z.string().trim().max(60)).max(40).default([]),
  baseLocation: latLngSchema,
});
export type CreateAmbulanceInput = z.infer<typeof createAmbulanceSchema>;

export const updateAmbulanceSchema = createAmbulanceSchema.partial().extend({
  status: z.enum(AMBULANCE_STATUSES).optional(),
});

export const createHospitalSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300),
  phone: phoneSchema,
  location: latLngSchema,
  /** Highest level of trauma care available, 1 being the most capable. */
  traumaLevel: z.number().int().min(1).max(4).default(3),
  specialties: z.array(z.string().trim().max(60)).max(40).default([]),
  beds: z
    .object({
      total: z.number().int().min(0).max(5000),
      available: z.number().int().min(0).max(5000),
    })
    .default({ total: 0, available: 0 }),
});
export type CreateHospitalInput = z.infer<typeof createHospitalSchema>;

export const updateBedsSchema = z.object({
  total: z.number().int().min(0).max(5000).optional(),
  available: z.number().int().min(0).max(5000).optional(),
});

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(200).default(15),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
