/**
 * The exact JSON shapes the API returns. Controllers build these explicitly
 * rather than serialising Mongoose documents, so no internal field (a password
 * hash, an audit trail, a soft-delete flag) can leak by accident.
 */

import type {
  AmbulanceStatus,
  AmbulanceType,
  BloodGroup,
  EmergencyType,
  Priority,
  RequestStatus,
  Role,
} from './enums.js';
import type { LatLng } from './geo.js';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  bloodGroup: BloodGroup;
  emergencyContact?: { name: string; phone: string };
  medicalNotes?: string;
  createdAt: string;
}

export interface AuthResponse {
  user: UserDto;
  accessToken: string;
  expiresIn: number;
}

export interface HospitalDto {
  id: string;
  name: string;
  address: string;
  phone: string;
  location: LatLng;
  traumaLevel: number;
  specialties: string[];
  beds: { total: number; available: number };
  /** Present only on proximity queries. */
  distanceMetres?: number;
}

export interface AmbulanceDto {
  id: string;
  vehicleNumber: string;
  type: AmbulanceType;
  status: AmbulanceStatus;
  location: LatLng | null;
  heading: number;
  speedMps: number;
  crew: Array<{ name: string; role: string }>;
  equipment: string[];
  driver?: { id: string; name: string; phone: string };
  hospital?: { id: string; name: string };
  activeRequestId?: string | null;
  lastSeenAt: string | null;
  /** Present only on proximity queries. */
  distanceMetres?: number;
}

export interface RouteDto {
  /** Decoded polyline as map-ready points. */
  points: LatLng[];
  distanceMetres: number;
  durationSeconds: number;
  /** `osrm` for real road routing, `straight-line` for the offline estimate. */
  source: 'osrm' | 'straight-line';
}

export interface TimelineEventDto {
  status: RequestStatus;
  at: string;
  note?: string;
  by?: string;
}

export interface EmergencyRequestDto {
  id: string;
  /** Short human-quotable reference, e.g. `SAS-7Q4M2`. */
  code: string;
  status: RequestStatus;
  priority: Priority;
  emergencyType: EmergencyType;
  triageReasons: string[];
  pickup: LatLng;
  pickupAddress?: string;
  notes?: string;
  contactPhone?: string;
  patient: { id: string; name: string; phone: string; bloodGroup: BloodGroup; medicalNotes?: string };
  ambulance?: AmbulanceDto | null;
  hospital?: HospitalDto | null;
  /** Live route from the ambulance to its current objective. */
  route?: RouteDto | null;
  etaSeconds?: number | null;
  etaUpdatedAt?: string | null;
  timeline: TimelineEventDto[];
  /** Seconds from request creation to the crew reaching the patient. */
  responseSeconds?: number | null;
  rating?: { stars: number; comment?: string } | null;
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchOfferDto {
  requestId: string;
  code: string;
  priority: Priority;
  emergencyType: EmergencyType;
  pickup: LatLng;
  pickupAddress?: string;
  notes?: string;
  patientName: string;
  distanceMetres: number;
  etaSeconds: number;
  /** Wall-clock deadline (ISO) after which the offer passes to the next crew. */
  expiresAt: string;
}

export interface FleetStatsDto {
  fleet: Record<AmbulanceStatus, number>;
  activeRequests: number;
  requestsToday: number;
  completedToday: number;
  cancelledToday: number;
  /** Mean seconds from SOS to crew on scene, over completed cases today. */
  averageResponseSeconds: number | null;
  /** Share of cases that met the response target for their priority, 0..1. */
  slaComplianceRate: number | null;
  byPriority: Record<Priority, number>;
  hospitalBeds: { total: number; available: number };
}

export interface TimeSeriesPointDto {
  bucket: string;
  requests: number;
  completed: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}
