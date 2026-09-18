/**
 * The lifecycle of an emergency case, from the SOS press to a closed case.
 *
 * Dispatch (choosing and offering a vehicle) lives in `dispatch.service`; this
 * module owns everything else: creating a case, moving it forward as the crew
 * works it, cancelling, and rating.
 */

import { Types } from 'mongoose';
import {
  CREW_PROGRESSION,
  toLatLng,
  triage,
  type CreateEmergencyInput,
  type EmergencyRequestDto,
  type RequestStatus,
} from '@sas/shared';
import { logger } from '../config/logger.js';
import {
  Ambulance,
  EmergencyRequest,
  Hospital,
  User,
  generateRequestCode,
  type EmergencyRequestDocument,
  type UserDocument,
} from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { sameId } from '../utils/ids.js';
import { dispatchRequest, refreshEta, selectHospital } from './dispatch.service.js';
import { notifyUser } from './notification.service.js';
import { realtime } from './realtime.service.js';
import { recordAudit } from './audit.service.js';
import { loadRequestDto, REQUEST_POPULATION, serializeRequest } from './serialize.js';

/** A caller may only have one case open at a time. */
const OPEN_STATUSES: RequestStatus[] = [
  'PENDING',
  'SEARCHING',
  'ASSIGNED',
  'EN_ROUTE_TO_SCENE',
  'ON_SCENE',
  'TRANSPORTING',
  'ARRIVED_AT_HOSPITAL',
];

/** Request status -> the vehicle state it implies. */
const VEHICLE_STATUS_FOR: Partial<Record<RequestStatus, 'DISPATCHED' | 'ON_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'AVAILABLE'>> = {
  ASSIGNED: 'DISPATCHED',
  EN_ROUTE_TO_SCENE: 'DISPATCHED',
  ON_SCENE: 'ON_SCENE',
  TRANSPORTING: 'TRANSPORTING',
  ARRIVED_AT_HOSPITAL: 'AT_HOSPITAL',
  COMPLETED: 'AVAILABLE',
};

/**
 * Generates a case code, retrying on the (rare) collision rather than trusting
 * randomness. Five characters from a 30-symbol alphabet is ~24 million codes,
 * but a unique index is only useful if the writer handles the clash.
 */
async function allocateRequestCode(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = generateRequestCode();
    const clash = await EmergencyRequest.exists({ code });
    if (!clash) return code;
  }
  // Astronomically unlikely; fall back to something guaranteed unique.
  return `SAS-${new Types.ObjectId().toString().slice(-6).toUpperCase()}`;
}

export async function createEmergencyRequest(
  patient: UserDocument,
  input: CreateEmergencyInput,
  context: { ip?: string } = {},
): Promise<EmergencyRequestDto> {
  const existing = await EmergencyRequest.findOne({
    patient: patient._id,
    status: { $in: OPEN_STATUSES },
  });
  if (existing) {
    throw ApiError.conflict('You already have an active emergency request', {
      requestId: existing._id.toString(),
      code: existing.code,
    });
  }

  const assessment = triage(input.emergencyType, input.vitals);
  const code = await allocateRequestCode();

  const preferredHospital =
    input.preferredHospitalId && Types.ObjectId.isValid(input.preferredHospitalId)
      ? new Types.ObjectId(input.preferredHospitalId)
      : null;

  const request = await EmergencyRequest.create({
    code,
    status: 'PENDING',
    priority: assessment.priority,
    emergencyType: input.emergencyType,
    triageReasons: assessment.reasons,
    requiredAmbulanceType: assessment.minimumAmbulanceType,
    pickup: { type: 'Point', coordinates: [input.pickup.lng, input.pickup.lat] },
    pickupAddress: input.pickupAddress,
    notes: input.notes,
    contactPhone: input.contactPhone ?? patient.phone,
    patient: patient._id,
    patientSnapshot: {
      name: patient.name,
      phone: patient.phone,
      bloodGroup: patient.bloodGroup,
      medicalNotes: patient.medicalNotes,
    },
    preferredHospital,
    // Chosen up front so the control room and the crew can see the intended
    // destination immediately; it can still change when transport starts.
    hospital: await selectHospital(input.pickup, assessment.priority, preferredHospital),
    timeline: [{ status: 'PENDING', at: new Date(), note: 'Emergency request received' }],
  });

  // Remember where the caller was, so a future SOS can prefill instantly.
  await User.updateOne(
    { _id: patient._id },
    { $set: { lastLocation: { type: 'Point', coordinates: [input.pickup.lng, input.pickup.lat] } } },
  );

  recordAudit({
    actorId: patient._id.toString(),
    actorRole: patient.role,
    action: 'request.created',
    entityType: 'EmergencyRequest',
    entityId: request._id.toString(),
    meta: { code, priority: assessment.priority, emergencyType: input.emergencyType },
    ip: context.ip,
  });

  const dto = (await loadRequestDto(request._id.toString()))!;
  realtime.requestCreated(dto);

  // Dispatch runs detached: the caller gets their case id immediately and the
  // crew offer arrives over the socket a moment later. An SOS response must not
  // wait on a geospatial search plus a routing call.
  void dispatchRequest(request._id.toString()).catch((error: unknown) => {
    logger.error({ err: error, requestId: request._id.toString() }, 'Dispatch failed');
  });

  logger.info({ code, priority: assessment.priority }, 'Emergency request created');
  return dto;
}

/**
 * Moves a case forward. Only the assigned crew may call this, and only forwards
 * along the defined progression -- a case cannot go back from TRANSPORTING to
 * ON_SCENE, and cannot skip from ASSIGNED straight to COMPLETED.
 */
export async function advanceRequestStatus(options: {
  requestId: string;
  driverUserId: string;
  status: Extract<
    RequestStatus,
    'EN_ROUTE_TO_SCENE' | 'ON_SCENE' | 'TRANSPORTING' | 'ARRIVED_AT_HOSPITAL' | 'COMPLETED'
  >;
  destinationHospitalId?: string;
  note?: string;
}): Promise<EmergencyRequestDto> {
  const { requestId, driverUserId, status, destinationHospitalId, note } = options;

  const request = await EmergencyRequest.findById(requestId);
  if (!request) throw ApiError.notFound('Emergency request not found');
  if (!request.ambulance) throw ApiError.conflict('This case has no ambulance assigned yet');

  const vehicle = await Ambulance.findById(request.ambulance);
  if (!vehicle) throw ApiError.conflict('The assigned ambulance no longer exists');
  if (vehicle.driver.toString() !== driverUserId) {
    throw ApiError.forbidden('You are not the crew assigned to this case');
  }

  const currentIndex = CREW_PROGRESSION.indexOf(request.status);
  const targetIndex = CREW_PROGRESSION.indexOf(status);
  if (currentIndex === -1) {
    throw ApiError.conflict(`A case that is ${request.status} can no longer be updated`);
  }
  if (targetIndex <= currentIndex) {
    throw ApiError.conflict(`The case is already at or past ${status}`);
  }
  if (targetIndex > currentIndex + 1) {
    const expected = CREW_PROGRESSION[currentIndex + 1];
    throw ApiError.unprocessable(`The next step for this case is ${expected}, not ${status}`);
  }

  const now = new Date();
  request.status = status;
  request.timeline.push({
    status,
    at: now,
    ...(note ? { note } : {}),
    by: vehicle.vehicleNumber,
  });

  if (status === 'ON_SCENE') {
    request.onSceneAt = now;
    // The headline metric: SOS press to crew at the patient's side.
    request.responseSeconds = Math.round((now.getTime() - request.createdAt.getTime()) / 1000);
  }

  if (status === 'TRANSPORTING' && destinationHospitalId) {
    const hospital = await Hospital.findOne({ _id: destinationHospitalId, isActive: true });
    if (!hospital) throw ApiError.badRequest('That destination hospital was not found');
    request.hospital = hospital._id;
  }

  if (status === 'ARRIVED_AT_HOSPITAL' && request.hospital) {
    // The patient now occupies a bed. Guarded so a double submission cannot
    // drive the count below zero.
    await Hospital.updateOne(
      { _id: request.hospital, 'beds.available': { $gt: 0 } },
      { $inc: { 'beds.available': -1 } },
    );
    realtime.toHospital(request.hospital.toString(), 'request:status', {
      requestId,
      status,
      at: now.toISOString(),
    });
  }

  if (status === 'COMPLETED') {
    request.completedAt = now;
    request.route = null;
    request.etaSeconds = null;
  }

  await request.save();

  const vehicleStatus = VEHICLE_STATUS_FOR[status];
  if (vehicleStatus) {
    vehicle.status = vehicleStatus;
    if (status === 'COMPLETED') {
      vehicle.activeRequest = null;
      vehicle.stats.completedTrips += 1;
    }
    await vehicle.save();
    realtime.ambulanceStatus(vehicle._id.toString(), vehicle.status);
  }

  realtime.requestStatus(
    { requestId, status, at: now.toISOString(), ...(note ? { note } : {}) },
    request.patient.toString(),
  );

  // Once transporting, the vehicle is heading somewhere new; re-route.
  if (status === 'TRANSPORTING') await refreshEta(requestId);

  const dto = (await loadRequestDto(requestId))!;
  realtime.requestUpdated(dto);

  await notifyUser({
    userId: request.patient.toString(),
    level: status === 'COMPLETED' ? 'success' : 'info',
    title: statusHeadline(status),
    ...(note ? { body: note } : {}),
    requestId,
  });

  recordAudit({
    actorId: driverUserId,
    actorRole: 'driver',
    action: `request.${status.toLowerCase()}`,
    entityType: 'EmergencyRequest',
    entityId: requestId,
    meta: { vehicleNumber: vehicle.vehicleNumber },
  });

  return dto;
}

function statusHeadline(status: RequestStatus): string {
  switch (status) {
    case 'EN_ROUTE_TO_SCENE':
      return 'Your ambulance is on the way';
    case 'ON_SCENE':
      return 'The crew has arrived';
    case 'TRANSPORTING':
      return 'On the way to hospital';
    case 'ARRIVED_AT_HOSPITAL':
      return 'Arrived at hospital';
    case 'COMPLETED':
      return 'Case closed';
    default:
      return 'Emergency update';
  }
}

/**
 * Cancels a case. The caller may cancel until the crew is with them; an admin
 * may cancel at any point before the case is closed.
 */
export async function cancelRequest(options: {
  requestId: string;
  actorId: string;
  actorRole: string;
  reason: string;
}): Promise<EmergencyRequestDto> {
  const { requestId, actorId, actorRole, reason } = options;

  const request = await EmergencyRequest.findById(requestId);
  if (!request) throw ApiError.notFound('Emergency request not found');

  const isOwner = request.patient.toString() === actorId;
  const isAdmin = actorRole === 'admin';
  if (!isOwner && !isAdmin) throw ApiError.forbidden('You cannot cancel this request');

  if (!OPEN_STATUSES.includes(request.status)) {
    throw ApiError.conflict(`A case that is ${request.status} cannot be cancelled`);
  }
  if (!isAdmin && ['ON_SCENE', 'TRANSPORTING', 'ARRIVED_AT_HOSPITAL'].includes(request.status)) {
    throw ApiError.conflict('The crew is already with the patient; please speak to them directly');
  }

  const now = new Date();
  request.status = 'CANCELLED';
  request.cancellationReason = reason;
  request.cancelledBy = new Types.ObjectId(actorId);
  request.timeline.push({ status: 'CANCELLED', at: now, note: reason });
  request.route = null;
  request.etaSeconds = null;
  await request.save();

  // Free whichever vehicle was holding this case, whether committed or
  // merely offered.
  if (request.ambulance) {
    const vehicle = await Ambulance.findById(request.ambulance);
    if (vehicle) {
      vehicle.status = 'AVAILABLE';
      vehicle.activeRequest = null;
      vehicle.offerExpiresAt = null;
      vehicle.stats.cancelledTrips += 1;
      await vehicle.save();
      realtime.ambulanceStatus(vehicle._id.toString(), 'AVAILABLE');
      await notifyUser({
        userId: vehicle.driver.toString(),
        level: 'warning',
        title: `Case ${request.code} was cancelled`,
        body: reason,
        requestId,
      });
    }
  } else {
    const pending = request.dispatchAttempts.find((attempt) => attempt.outcome === 'PENDING');
    if (pending) {
      pending.outcome = 'SUPERSEDED';
      pending.respondedAt = now;
      await request.save();
      const offered = await Ambulance.findOneAndUpdate(
        { _id: pending.ambulance, status: 'OFFERED' },
        { $set: { status: 'AVAILABLE', offerExpiresAt: null } },
        { new: true },
      );
      if (offered) {
        realtime.revokeOffer(offered.driver.toString(), requestId, 'The caller cancelled');
        realtime.ambulanceStatus(offered._id.toString(), 'AVAILABLE');
      }
    }
  }

  realtime.requestStatus(
    { requestId, status: 'CANCELLED', at: now.toISOString(), note: reason },
    request.patient.toString(),
  );

  const dto = (await loadRequestDto(requestId))!;
  realtime.requestUpdated(dto);

  recordAudit({
    actorId,
    actorRole,
    action: 'request.cancelled',
    entityType: 'EmergencyRequest',
    entityId: requestId,
    meta: { reason },
  });

  return dto;
}

export async function rateRequest(options: {
  requestId: string;
  patientId: string;
  stars: number;
  comment?: string;
}): Promise<EmergencyRequestDto> {
  const request = await EmergencyRequest.findById(options.requestId);
  if (!request) throw ApiError.notFound('Emergency request not found');
  if (request.patient.toString() !== options.patientId) {
    throw ApiError.forbidden('You can only rate your own request');
  }
  if (request.status !== 'COMPLETED') {
    throw ApiError.conflict('You can rate a case once it has been completed');
  }
  if (request.rating) throw ApiError.conflict('This case has already been rated');

  request.rating = {
    stars: options.stars,
    ...(options.comment ? { comment: options.comment } : {}),
  };
  await request.save();

  return (await loadRequestDto(options.requestId))!;
}

/** Loads a case, enforcing that the caller is entitled to see it. */
export async function getVisibleRequest(
  requestId: string,
  viewer: { id: string; role: string },
): Promise<EmergencyRequestDto> {
  if (!Types.ObjectId.isValid(requestId)) throw ApiError.badRequest('Invalid request id');

  const request = (await EmergencyRequest.findById(requestId).populate(
    REQUEST_POPULATION as unknown as string[],
  )) as EmergencyRequestDocument | null;
  if (!request) throw ApiError.notFound('Emergency request not found');

  if (viewer.role === 'admin' || viewer.role === 'hospital') return serializeRequest(request);
  if (sameId(request.patient, viewer.id)) return serializeRequest(request);

  if (viewer.role === 'driver') {
    // A crew can see a case if their vehicle holds it, or has been offered it.
    // `request.ambulance` is populated here, so the comparison has to go
    // through `sameId` rather than stringifying a document.
    const vehicle = await Ambulance.findOne({ driver: viewer.id });
    if (vehicle) {
      const isAssigned = sameId(request.ambulance, vehicle._id);
      const isOffered = request.dispatchAttempts.some(
        (attempt) => sameId(attempt.ambulance, vehicle._id) && attempt.outcome === 'PENDING',
      );
      if (isAssigned || isOffered) return serializeRequest(request);
    }
  }

  throw ApiError.forbidden('You do not have access to this request');
}
