/**
 * Triage: turning what a caller reports into a dispatch priority and a minimum
 * vehicle capability.
 *
 * This is deliberately a transparent rule table rather than a model. Dispatch
 * decisions have to be explainable after the fact, and every rule here maps to
 * something a human dispatcher would also say out loud.
 */

import type { AmbulanceType, EmergencyType, Priority } from './enums.js';
import { AMBULANCE_TYPE_RANK, AMBULANCE_TYPES } from './enums.js';

/** Vitals a caller (or a first responder) can report alongside the request. */
export interface ReportedVitals {
  conscious?: boolean;
  breathing?: boolean;
  bleedingSeverely?: boolean;
  /** Number of people involved; a mass-casualty hint. */
  victimCount?: number;
  patientAgeYears?: number;
}

export interface TriageResult {
  priority: Priority;
  /** Lowest vehicle tier that may be sent to this case. */
  minimumAmbulanceType: AmbulanceType;
  /** Human-readable justification, stored on the case for audit. */
  reasons: string[];
}

const BASE_PRIORITY: Record<EmergencyType, Priority> = {
  CARDIAC: 'P1',
  STROKE: 'P1',
  RESPIRATORY: 'P1',
  TRAUMA: 'P2',
  BURNS: 'P2',
  OBSTETRIC: 'P2',
  POISONING: 'P2',
  PAEDIATRIC: 'P2',
  PSYCHIATRIC: 'P3',
  OTHER: 'P3',
};

const BASE_VEHICLE: Record<EmergencyType, AmbulanceType> = {
  CARDIAC: 'ALS',
  STROKE: 'ALS',
  RESPIRATORY: 'ALS',
  TRAUMA: 'ALS',
  BURNS: 'ALS',
  OBSTETRIC: 'BLS',
  POISONING: 'ALS',
  PAEDIATRIC: 'BLS',
  PSYCHIATRIC: 'BLS',
  OTHER: 'BLS',
};

const PRIORITY_ORDER: Priority[] = ['P1', 'P2', 'P3', 'P4'];

/** Returns whichever priority is more urgent (closer to P1). */
export function escalate(a: Priority, b: Priority): Priority {
  return PRIORITY_ORDER.indexOf(a) <= PRIORITY_ORDER.indexOf(b) ? a : b;
}

function raiseVehicle(a: AmbulanceType, b: AmbulanceType): AmbulanceType {
  return AMBULANCE_TYPE_RANK[a] >= AMBULANCE_TYPE_RANK[b] ? a : b;
}

export function triage(emergencyType: EmergencyType, vitals: ReportedVitals = {}): TriageResult {
  let priority = BASE_PRIORITY[emergencyType];
  let vehicle = BASE_VEHICLE[emergencyType];
  const reasons: string[] = [`Reported as ${emergencyType.toLowerCase()}`];

  if (vitals.breathing === false) {
    priority = escalate(priority, 'P1');
    vehicle = raiseVehicle(vehicle, 'MICU');
    reasons.push('Patient reported as not breathing');
  }
  if (vitals.conscious === false) {
    priority = escalate(priority, 'P1');
    vehicle = raiseVehicle(vehicle, 'ALS');
    reasons.push('Patient reported as unconscious');
  }
  if (vitals.bleedingSeverely) {
    priority = escalate(priority, 'P1');
    vehicle = raiseVehicle(vehicle, 'ALS');
    reasons.push('Severe bleeding reported');
  }
  if ((vitals.victimCount ?? 1) > 3) {
    priority = escalate(priority, 'P1');
    reasons.push(`Multiple casualties reported (${vitals.victimCount})`);
  }
  if (vitals.patientAgeYears !== undefined) {
    if (vitals.patientAgeYears <= 1) {
      vehicle = raiseVehicle(vehicle, 'NEONATAL');
      priority = escalate(priority, 'P1');
      reasons.push('Infant patient');
    } else if (vitals.patientAgeYears >= 70 && priority === 'P3') {
      priority = 'P2';
      reasons.push('Elderly patient, priority raised');
    }
  }

  return { priority, minimumAmbulanceType: vehicle, reasons };
}

/** True when `candidate` is clinically capable of taking a case needing `required`. */
export function vehicleMeets(candidate: AmbulanceType, required: AmbulanceType): boolean {
  return AMBULANCE_TYPE_RANK[candidate] >= AMBULANCE_TYPE_RANK[required];
}

/**
 * Every vehicle type capable of taking a case needing `required`.
 *
 * Exists so capability can be expressed as a database filter rather than
 * checked on query results. Filtering afterwards means nearer but unsuitable
 * vehicles can crowd a suitable one out of the fetched window, and the case is
 * then declared unservable while a capable ambulance sits inside the radius.
 */
export function vehicleTypesMeeting(required: AmbulanceType): AmbulanceType[] {
  return AMBULANCE_TYPES.filter((type) => vehicleMeets(type, required));
}
