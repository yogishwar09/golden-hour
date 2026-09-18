/**
 * Domain vocabulary shared by the API, the realtime layer and every client.
 *
 * These are plain string unions rather than TypeScript `enum`s so that the
 * values survive JSON serialisation unchanged and can be stored in MongoDB and
 * compared in Mongoose queries without a translation layer.
 */

export const ROLES = ['patient', 'driver', 'hospital', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Clinical capability tier of a vehicle, ordered from lowest to highest. */
export const AMBULANCE_TYPES = ['PTV', 'BLS', 'ALS', 'MICU', 'NEONATAL'] as const;
export type AmbulanceType = (typeof AMBULANCE_TYPES)[number];

export const AMBULANCE_TYPE_LABELS: Record<AmbulanceType, string> = {
  PTV: 'Patient Transport',
  BLS: 'Basic Life Support',
  ALS: 'Advanced Life Support',
  MICU: 'Mobile ICU',
  NEONATAL: 'Neonatal / Paediatric',
};

/** Higher rank == more capable. Used when matching a vehicle to a case. */
export const AMBULANCE_TYPE_RANK: Record<AmbulanceType, number> = {
  PTV: 0,
  BLS: 1,
  ALS: 2,
  MICU: 3,
  NEONATAL: 3,
};

export const AMBULANCE_STATUSES = [
  'OFFLINE',
  'AVAILABLE',
  'OFFERED',
  'DISPATCHED',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'OUT_OF_SERVICE',
] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

/** Vehicle states in which the dispatcher may consider offering a new case. */
export const DISPATCHABLE_STATUSES: AmbulanceStatus[] = ['AVAILABLE'];

export const EMERGENCY_TYPES = [
  'CARDIAC',
  'TRAUMA',
  'STROKE',
  'RESPIRATORY',
  'BURNS',
  'OBSTETRIC',
  'POISONING',
  'PAEDIATRIC',
  'PSYCHIATRIC',
  'OTHER',
] as const;
export type EmergencyType = (typeof EMERGENCY_TYPES)[number];

export const EMERGENCY_TYPE_LABELS: Record<EmergencyType, string> = {
  CARDIAC: 'Cardiac / Chest pain',
  TRAUMA: 'Accident / Trauma',
  STROKE: 'Stroke symptoms',
  RESPIRATORY: 'Breathing difficulty',
  BURNS: 'Burns',
  OBSTETRIC: 'Pregnancy / Childbirth',
  POISONING: 'Poisoning / Overdose',
  PAEDIATRIC: 'Child emergency',
  PSYCHIATRIC: 'Mental health crisis',
  OTHER: 'Other emergency',
};

/**
 * Triage priority, following the familiar P1..P4 convention used by most
 * ambulance services. P1 is immediately life-threatening.
 */
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: 'P1 - Immediate',
  P2: 'P2 - Emergency',
  P3: 'P3 - Urgent',
  P4: 'P4 - Non-urgent',
};

/** Target on-scene time in minutes per priority, used for SLA reporting. */
export const PRIORITY_SLA_MINUTES: Record<Priority, number> = {
  P1: 8,
  P2: 15,
  P3: 30,
  P4: 60,
};

export const REQUEST_STATUSES = [
  'PENDING',
  'SEARCHING',
  'ASSIGNED',
  'EN_ROUTE_TO_SCENE',
  'ON_SCENE',
  'TRANSPORTING',
  'ARRIVED_AT_HOSPITAL',
  'COMPLETED',
  'CANCELLED',
  'NO_AMBULANCE_AVAILABLE',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING: 'Request received',
  SEARCHING: 'Finding nearest ambulance',
  ASSIGNED: 'Ambulance assigned',
  EN_ROUTE_TO_SCENE: 'Ambulance on the way',
  ON_SCENE: 'Crew with patient',
  TRANSPORTING: 'Transporting to hospital',
  ARRIVED_AT_HOSPITAL: 'Arrived at hospital',
  COMPLETED: 'Case closed',
  CANCELLED: 'Cancelled',
  NO_AMBULANCE_AVAILABLE: 'No ambulance available',
};

/** Statuses after which the case no longer occupies a vehicle. */
export const TERMINAL_REQUEST_STATUSES: RequestStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NO_AMBULANCE_AVAILABLE',
];

/** The forward-only path a case takes once a crew has accepted it. */
export const CREW_PROGRESSION: RequestStatus[] = [
  'ASSIGNED',
  'EN_ROUTE_TO_SCENE',
  'ON_SCENE',
  'TRANSPORTING',
  'ARRIVED_AT_HOSPITAL',
  'COMPLETED',
];

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
