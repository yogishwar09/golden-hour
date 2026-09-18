/**
 * Document -> DTO conversion.
 *
 * Every response body is built here, from explicitly named fields. Nothing is
 * serialised by handing a Mongoose document to `res.json()`, so internal state
 * (dispatch attempts, audit fields, password hashes) cannot leak by accident.
 */

import { toLatLng, type EmergencyRequestDto, type TimelineEventDto } from '@sas/shared';
import { EmergencyRequest, type EmergencyRequestDocument } from '../models/index.js';
import { toId } from '../utils/ids.js';
import type { AmbulanceDocument } from '../models/Ambulance.js';
import type { HospitalDocument } from '../models/Hospital.js';

/** The population set every case DTO needs; used by every read path. */
export const REQUEST_POPULATION = [
  {
    path: 'ambulance',
    populate: [
      { path: 'driver', select: 'name phone' },
      { path: 'hospital', select: 'name' },
    ],
  },
  { path: 'hospital' },
] as const;

export function serializeRequest(doc: EmergencyRequestDocument): EmergencyRequestDto {
  const ambulance = doc.populated('ambulance')
    ? (doc.ambulance as unknown as AmbulanceDocument)
    : null;
  const hospital = doc.populated('hospital') ? (doc.hospital as unknown as HospitalDocument) : null;

  const timeline: TimelineEventDto[] = doc.timeline.map((entry) => ({
    status: entry.status,
    at: entry.at.toISOString(),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.by ? { by: entry.by } : {}),
  }));

  return {
    id: doc._id.toString(),
    code: doc.code,
    status: doc.status,
    priority: doc.priority,
    emergencyType: doc.emergencyType,
    triageReasons: doc.triageReasons,
    pickup: toLatLng(doc.pickup) ?? { lat: 0, lng: 0 },
    ...(doc.pickupAddress ? { pickupAddress: doc.pickupAddress } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.contactPhone ? { contactPhone: doc.contactPhone } : {}),
    patient: {
      id: toId(doc.patient) ?? '',
      name: doc.patientSnapshot.name,
      phone: doc.patientSnapshot.phone,
      bloodGroup: doc.patientSnapshot.bloodGroup,
      ...(doc.patientSnapshot.medicalNotes
        ? { medicalNotes: doc.patientSnapshot.medicalNotes }
        : {}),
    },
    ambulance: ambulance ? ambulance.toDto() : null,
    hospital: hospital ? hospital.toDto() : null,
    route: doc.route ?? null,
    etaSeconds: doc.etaSeconds ?? null,
    etaUpdatedAt: doc.etaUpdatedAt ? doc.etaUpdatedAt.toISOString() : null,
    timeline,
    responseSeconds: doc.responseSeconds ?? null,
    rating: doc.rating ?? null,
    ...(doc.cancellationReason ? { cancellationReason: doc.cancellationReason } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Re-reads a case with the standard population and serialises it. */
export async function loadRequestDto(requestId: string): Promise<EmergencyRequestDto | null> {
  const doc = await EmergencyRequest.findById(requestId).populate(
    REQUEST_POPULATION as unknown as string[],
  );
  return doc ? serializeRequest(doc) : null;
}
