/**
 * The dispatcher.
 *
 * Finds the best vehicle for a case and offers it to that crew. If the crew
 * declines or does not answer within the offer window, the case cascades to the
 * next-best vehicle automatically. A case is only ever committed to one vehicle,
 * and a vehicle is only ever committed to one case.
 *
 * Correctness notes
 * -----------------
 * Two SOS calls can arrive milliseconds apart and rank the same ambulance
 * first. Every claim on a vehicle therefore goes through a conditional
 * `findOneAndUpdate` that both checks and sets the status in one atomic
 * document update -- the loser of the race simply sees `null` and moves to its
 * next candidate. Nothing here relies on read-then-write.
 *
 * Scaling note
 * ------------
 * Offer timeouts are in-process `setTimeout`s, which is correct for a single
 * API instance. Running several instances behind a load balancer would move
 * these to a shared delayed queue (BullMQ/Redis); `scheduleOfferTimeout` and
 * `clearOfferTimeout` are the only two places that would change.
 */

import { Types } from 'mongoose';
import {
  haversineMetres,
  rooms,
  toLatLng,
  vehicleMeets,
  type AmbulanceType,
  type DispatchOfferDto,
  type LatLng,
} from '@sas/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  Ambulance,
  EmergencyRequest,
  Hospital,
  type AmbulanceDocument,
  type EmergencyRequestDocument,
} from '../models/index.js';
import { applyEmergencyFactor, estimateSeconds, getRoute } from './routing.service.js';
import { notifyUser } from './notification.service.js';
import { realtime } from './realtime.service.js';
import { recordAudit } from './audit.service.js';
import { loadRequestDto } from './serialize.js';

interface Candidate {
  ambulance: AmbulanceDocument;
  distanceMetres: number;
  etaSeconds: number;
  score: number;
}

/** Pending offer timers, keyed by request id. See the scaling note above. */
const offerTimers = new Map<string, NodeJS.Timeout>();

function clearOfferTimeout(requestId: string): void {
  const timer = offerTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    offerTimers.delete(requestId);
  }
}

function scheduleOfferTimeout(requestId: string, ambulanceId: string): void {
  clearOfferTimeout(requestId);
  const timer = setTimeout(() => {
    offerTimers.delete(requestId);
    void handleOfferTimeout(requestId, ambulanceId);
  }, env.DISPATCH_OFFER_TIMEOUT_SECONDS * 1000);
  // Do not hold the process open purely for a pending offer timer.
  timer.unref?.();
  offerTimers.set(requestId, timer);
}

/**
 * Ranks candidate vehicles. Travel time dominates, because minutes to the
 * patient is the metric that matters clinically. The small capability penalty
 * breaks ties towards sending the *least* over-specified vehicle that still
 * meets the case, keeping ICU units free for cases that need them.
 */
function scoreCandidate(etaSeconds: number, type: AmbulanceType, required: AmbulanceType): number {
  const overCapabilityPenalty = vehicleMeets(type, required) && type !== required ? 45 : 0;
  return etaSeconds + overCapabilityPenalty;
}

/**
 * Nearest suitable vehicles, best first. Excludes anything already committed to
 * a case or holding an outstanding offer.
 */
export async function findCandidates(
  pickup: LatLng,
  requiredType: AmbulanceType,
  radiusKm: number,
  limit: number,
  excludeIds: string[] = [],
): Promise<Candidate[]> {
  const excluded = excludeIds.filter(Types.ObjectId.isValid).map((id) => new Types.ObjectId(id));

  const vehicles = await Ambulance.find({
    status: 'AVAILABLE',
    isActive: true,
    activeRequest: null,
    ...(excluded.length ? { _id: { $nin: excluded } } : {}),
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    // Over-fetch, because the capability filter below removes some results and
    // `$nearSphere` cannot express "rank at least this tier" on its own.
    .limit(limit * 4)
    .populate('driver', 'name phone')
    .exec();

  const candidates: Candidate[] = [];
  for (const vehicle of vehicles) {
    if (!vehicleMeets(vehicle.type, requiredType)) continue;

    const position = toLatLng(vehicle.location);
    if (!position) continue;

    const distanceMetres = haversineMetres(position, pickup);
    const etaSeconds = applyEmergencyFactor(estimateSeconds(position, pickup));
    candidates.push({
      ambulance: vehicle,
      distanceMetres,
      etaSeconds,
      score: scoreCandidate(etaSeconds, vehicle.type, requiredType),
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, limit);
}

/**
 * Picks the receiving hospital: the caller's preference when they gave one,
 * otherwise the nearest active hospital with a free bed, preferring higher
 * trauma capability for P1 cases.
 */
export async function selectHospital(
  pickup: LatLng,
  priority: string,
  preferredHospitalId?: Types.ObjectId | null,
): Promise<Types.ObjectId | null> {
  if (preferredHospitalId) {
    const preferred = await Hospital.findOne({ _id: preferredHospitalId, isActive: true });
    if (preferred) return preferred._id;
  }

  const nearby = await Hospital.find({
    isActive: true,
    'beds.available': { $gt: 0 },
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: env.DISPATCH_MAX_RADIUS_KM * 1000,
      },
    },
  })
    .limit(10)
    .exec();

  if (nearby.length === 0) {
    // Better to send the patient to a full hospital than to nowhere; the crew
    // can divert en route.
    const fallback = await Hospital.findOne({ isActive: true }).exec();
    return fallback?._id ?? null;
  }

  if (priority === 'P1') {
    // `nearby` is already distance-ordered, so a stable sort on trauma level
    // yields "most capable, nearest first among equals".
    const byCapability = [...nearby].sort((a, b) => a.traumaLevel - b.traumaLevel);
    return byCapability[0]?._id ?? nearby[0]?._id ?? null;
  }

  return nearby[0]?._id ?? null;
}

/** Ambulance ids this case has already tried, so it never loops back. */
function attemptedIds(request: EmergencyRequestDocument): string[] {
  return request.dispatchAttempts.map((attempt) => attempt.ambulance.toString());
}

/**
 * Runs (or continues) dispatch for a case: picks the next candidate and offers
 * it. Safe to call repeatedly; it exits quietly if the case already has a crew
 * or has reached a terminal state.
 */
export async function dispatchRequest(requestId: string): Promise<void> {
  const request = await EmergencyRequest.findById(requestId);
  if (!request) return;

  if (!['PENDING', 'SEARCHING'].includes(request.status)) {
    logger.debug({ requestId, status: request.status }, 'Dispatch skipped; case is no longer open');
    return;
  }

  const pickup = toLatLng(request.pickup);
  if (!pickup) {
    logger.error({ requestId }, 'Case has no usable pickup location');
    return;
  }

  if (request.status === 'PENDING') {
    request.status = 'SEARCHING';
    request.timeline.push({ status: 'SEARCHING', at: new Date(), note: 'Searching for a vehicle' });
    await request.save();
    realtime.requestStatus(
      { requestId, status: 'SEARCHING', at: new Date().toISOString() },
      request.patient.toString(),
    );
  }

  const tried = attemptedIds(request);
  if (tried.length >= env.DISPATCH_MAX_CANDIDATES) {
    await markNoAmbulanceAvailable(request, 'Every nearby crew was unavailable');
    return;
  }

  // First pass close in, then a widened sweep before giving up.
  let candidates = await findCandidates(
    pickup,
    request.requiredAmbulanceType,
    env.DISPATCH_SEARCH_RADIUS_KM,
    3,
    tried,
  );
  if (candidates.length === 0) {
    candidates = await findCandidates(
      pickup,
      request.requiredAmbulanceType,
      env.DISPATCH_MAX_RADIUS_KM,
      3,
      tried,
    );
  }

  const best = candidates[0];
  if (!best) {
    await markNoAmbulanceAvailable(request, 'No suitable ambulance is available nearby');
    return;
  }

  const offered = await offerToCandidate(request, best);
  if (!offered) {
    // Another case claimed this vehicle first. Record the attempt so we do not
    // retry it, then immediately try the next-best.
    request.dispatchAttempts.push({
      ambulance: best.ambulance._id,
      offeredAt: new Date(),
      respondedAt: new Date(),
      outcome: 'SUPERSEDED',
      reason: 'Vehicle was claimed by another case',
      distanceMetres: Math.round(best.distanceMetres),
      etaSeconds: best.etaSeconds,
    });
    await request.save();
    await dispatchRequest(requestId);
  }
}

/**
 * Attempts to claim a vehicle and send its crew the offer.
 * Returns false when the vehicle was taken by a competing case.
 */
async function offerToCandidate(
  request: EmergencyRequestDocument,
  candidate: Candidate,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + env.DISPATCH_OFFER_TIMEOUT_SECONDS * 1000);

  // The atomic claim: only succeeds if the vehicle is still free right now.
  const claimed = await Ambulance.findOneAndUpdate(
    { _id: candidate.ambulance._id, status: 'AVAILABLE', activeRequest: null },
    { $set: { status: 'OFFERED', offerExpiresAt: expiresAt } },
    { new: true },
  );
  if (!claimed) return false;

  request.dispatchAttempts.push({
    ambulance: claimed._id,
    offeredAt: new Date(),
    outcome: 'PENDING',
    distanceMetres: Math.round(candidate.distanceMetres),
    etaSeconds: candidate.etaSeconds,
  });
  await request.save();

  const offer: DispatchOfferDto = {
    requestId: request._id.toString(),
    code: request.code,
    priority: request.priority,
    emergencyType: request.emergencyType,
    pickup: toLatLng(request.pickup) ?? { lat: 0, lng: 0 },
    ...(request.pickupAddress ? { pickupAddress: request.pickupAddress } : {}),
    ...(request.notes ? { notes: request.notes } : {}),
    patientName: request.patientSnapshot.name,
    distanceMetres: Math.round(candidate.distanceMetres),
    etaSeconds: candidate.etaSeconds,
    expiresAt: expiresAt.toISOString(),
  };

  realtime.offer(claimed.driver.toString(), offer);
  realtime.ambulanceStatus(claimed._id.toString(), 'OFFERED');
  scheduleOfferTimeout(request._id.toString(), claimed._id.toString());

  logger.info(
    {
      requestId: request._id.toString(),
      vehicle: claimed.vehicleNumber,
      eta: candidate.etaSeconds,
    },
    'Offered case to crew',
  );
  return true;
}

/** Puts a vehicle back in service if it is still holding this case's offer. */
async function releaseOfferedVehicle(ambulanceId: string): Promise<void> {
  const released = await Ambulance.findOneAndUpdate(
    { _id: ambulanceId, status: 'OFFERED' },
    { $set: { status: 'AVAILABLE', offerExpiresAt: null } },
    { new: true },
  );
  if (released) realtime.ambulanceStatus(ambulanceId, 'AVAILABLE');
}

async function handleOfferTimeout(requestId: string, ambulanceId: string): Promise<void> {
  try {
    const request = await EmergencyRequest.findById(requestId);
    if (!request || request.status !== 'SEARCHING') return;

    const attempt = request.dispatchAttempts.find(
      (entry) => entry.ambulance.toString() === ambulanceId && entry.outcome === 'PENDING',
    );
    if (!attempt) return;

    attempt.outcome = 'TIMED_OUT';
    attempt.respondedAt = new Date();
    await request.save();

    const vehicle = await Ambulance.findById(ambulanceId);
    if (vehicle) {
      realtime.revokeOffer(vehicle.driver.toString(), requestId, 'Offer expired');
      await Ambulance.updateOne({ _id: ambulanceId }, { $inc: { 'stats.declinedOffers': 1 } });
    }
    await releaseOfferedVehicle(ambulanceId);

    logger.warn({ requestId, ambulanceId }, 'Crew did not respond in time; trying next vehicle');
    await dispatchRequest(requestId);
  } catch (error) {
    logger.error({ err: error, requestId }, 'Offer timeout handling failed');
  }
}

/**
 * A crew accepted. Commits the vehicle to the case, computes the first route
 * and ETA, and tells everyone watching.
 *
 * Returns false when the offer is no longer valid (expired, revoked, or already
 * answered), which the caller reports to the driver as a stale offer.
 */
export async function acceptOffer(requestId: string, driverUserId: string): Promise<boolean> {
  const request = await EmergencyRequest.findById(requestId);
  if (!request || request.status !== 'SEARCHING') return false;

  const vehicle = await Ambulance.findOne({ driver: driverUserId, status: 'OFFERED' });
  if (!vehicle) return false;

  const attempt = request.dispatchAttempts.find(
    (entry) => entry.ambulance.toString() === vehicle._id.toString() && entry.outcome === 'PENDING',
  );
  if (!attempt) return false;

  // Atomic commit: the vehicle must still be the one holding this offer.
  const committed = await Ambulance.findOneAndUpdate(
    { _id: vehicle._id, status: 'OFFERED' },
    { $set: { status: 'DISPATCHED', activeRequest: request._id, offerExpiresAt: null } },
    { new: true },
  );
  if (!committed) return false;

  clearOfferTimeout(requestId);

  attempt.outcome = 'ACCEPTED';
  attempt.respondedAt = new Date();
  request.ambulance = committed._id;
  request.status = 'ASSIGNED';
  request.assignedAt = new Date();
  request.timeline.push({
    status: 'ASSIGNED',
    at: new Date(),
    note: `Assigned to ${committed.vehicleNumber}`,
  });

  if (!request.hospital) {
    request.hospital = await selectHospital(
      toLatLng(request.pickup) ?? { lat: 0, lng: 0 },
      request.priority,
      request.preferredHospital ?? null,
    );
  }

  await request.save();
  await refreshEta(request._id.toString());

  realtime.ambulanceStatus(committed._id.toString(), 'DISPATCHED');
  const dto = await loadRequestDto(requestId);
  if (dto) realtime.requestUpdated(dto);

  await notifyUser({
    userId: request.patient.toString(),
    level: 'success',
    title: 'Ambulance assigned',
    body: `${committed.vehicleNumber} is on the way to you.`,
    requestId,
  });

  recordAudit({
    actorId: driverUserId,
    actorRole: 'driver',
    action: 'dispatch.accepted',
    entityType: 'EmergencyRequest',
    entityId: requestId,
    meta: { vehicleNumber: committed.vehicleNumber },
  });

  logger.info({ requestId, vehicle: committed.vehicleNumber }, 'Crew accepted case');
  return true;
}

/** A crew declined. Frees the vehicle and moves the case to the next candidate. */
export async function declineOffer(
  requestId: string,
  driverUserId: string,
  reason?: string,
): Promise<boolean> {
  const vehicle = await Ambulance.findOne({ driver: driverUserId, status: 'OFFERED' });
  if (!vehicle) return false;

  const request = await EmergencyRequest.findById(requestId);
  if (!request) return false;

  const attempt = request.dispatchAttempts.find(
    (entry) => entry.ambulance.toString() === vehicle._id.toString() && entry.outcome === 'PENDING',
  );
  if (!attempt) return false;

  clearOfferTimeout(requestId);
  attempt.outcome = 'DECLINED';
  attempt.respondedAt = new Date();
  if (reason) attempt.reason = reason;
  await request.save();

  await Ambulance.updateOne({ _id: vehicle._id }, { $inc: { 'stats.declinedOffers': 1 } });
  await releaseOfferedVehicle(vehicle._id.toString());

  recordAudit({
    actorId: driverUserId,
    actorRole: 'driver',
    action: 'dispatch.declined',
    entityType: 'EmergencyRequest',
    entityId: requestId,
    meta: { vehicleNumber: vehicle.vehicleNumber, reason },
  });

  await dispatchRequest(requestId);
  return true;
}

async function markNoAmbulanceAvailable(
  request: EmergencyRequestDocument,
  reason: string,
): Promise<void> {
  request.status = 'NO_AMBULANCE_AVAILABLE';
  request.timeline.push({ status: 'NO_AMBULANCE_AVAILABLE', at: new Date(), note: reason });
  await request.save();

  const requestId = request._id.toString();
  realtime.requestStatus(
    { requestId, status: 'NO_AMBULANCE_AVAILABLE', at: new Date().toISOString(), note: reason },
    request.patient.toString(),
  );

  await notifyUser({
    userId: request.patient.toString(),
    level: 'critical',
    title: 'No ambulance available',
    body: `${reason}. Please call your local emergency number immediately.`,
    requestId,
  });

  logger.error({ requestId, reason }, 'Dispatch exhausted with no vehicle assigned');
}

/**
 * Recomputes the route and ETA for a live case, from the ambulance's current
 * position to whatever it is currently heading for -- the patient before
 * pickup, the hospital after -- and broadcasts the result.
 */
export async function refreshEta(requestId: string): Promise<void> {
  const request = await EmergencyRequest.findById(requestId);
  if (!request?.ambulance) return;

  const vehicle = await Ambulance.findById(request.ambulance);
  const from = vehicle ? toLatLng(vehicle.location) : null;
  if (!from) return;

  const headingToHospital = ['TRANSPORTING', 'ARRIVED_AT_HOSPITAL'].includes(request.status);
  let destination = toLatLng(request.pickup);

  if (headingToHospital && request.hospital) {
    const hospital = await Hospital.findById(request.hospital);
    const hospitalPoint = hospital ? toLatLng(hospital.location) : null;
    if (hospitalPoint) destination = hospitalPoint;
  }
  if (!destination) return;

  const route = await getRoute(from, destination);
  const etaSeconds = applyEmergencyFactor(route.durationSeconds);

  request.route = route;
  request.etaSeconds = etaSeconds;
  request.etaUpdatedAt = new Date();
  await request.save();

  realtime.eta(
    {
      requestId,
      etaSeconds,
      distanceMetres: route.distanceMetres,
      route,
      at: new Date().toISOString(),
    },
    request.patient.toString(),
  );
}

/** Test seam: drops pending offer timers so a suite can exit cleanly. */
export function clearAllOfferTimers(): void {
  for (const timer of offerTimers.values()) clearTimeout(timer);
  offerTimers.clear();
}

export { rooms };
