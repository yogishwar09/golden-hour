import type { Request, Response } from 'express';
import type { LocationPingInput } from '@sas/shared';
import { Ambulance, EmergencyRequest } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { acceptOffer, declineOffer } from '../services/dispatch.service.js';
import { advanceRequestStatus } from '../services/request.service.js';
import { recordLocationPing } from '../services/tracking.service.js';
import { realtime } from '../services/realtime.service.js';
import { recordAudit } from '../services/audit.service.js';
import { REQUEST_POPULATION, serializeRequest } from '../services/serialize.js';

/** Everything a crew device needs on load: its vehicle and any live case. */
export const getMyShift = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const vehicle = await Ambulance.findOne({ driver: req.user._id })
    .populate('driver', 'name phone')
    .populate('hospital', 'name');
  if (!vehicle) throw ApiError.notFound('No ambulance is assigned to your account');

  const activeCase = vehicle.activeRequest
    ? await EmergencyRequest.findById(vehicle.activeRequest).populate(
        REQUEST_POPULATION as unknown as string[],
      )
    : null;

  res.json({
    ambulance: vehicle.toDto(),
    activeRequest: activeCase ? serializeRequest(activeCase) : null,
  });
});

/**
 * Going on or off duty.
 *
 * A crew cannot go off duty mid-case: the patient is relying on them, and
 * silently freeing the vehicle would strand the case in an assigned state with
 * nobody driving.
 */
export const setDutyStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { status } = req.body as { status: 'OFFLINE' | 'AVAILABLE' | 'OUT_OF_SERVICE' };

  const vehicle = await Ambulance.findOne({ driver: req.user._id });
  if (!vehicle) throw ApiError.notFound('No ambulance is assigned to your account');

  if (vehicle.activeRequest) {
    throw ApiError.conflict('Finish or hand over your current case before changing duty status');
  }
  if (vehicle.status === 'OFFERED') {
    throw ApiError.conflict('Respond to the pending dispatch offer first');
  }

  vehicle.status = status;
  vehicle.lastSeenAt = new Date();
  await vehicle.save();

  realtime.ambulanceStatus(vehicle._id.toString(), status);
  recordAudit({
    actorId: req.user._id.toString(),
    actorRole: 'driver',
    action: 'driver.duty_status',
    entityType: 'Ambulance',
    entityId: vehicle._id.toString(),
    meta: { status },
  });

  res.json({ ambulance: vehicle.toDto() });
});

export const respondToOffer = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { requestId, accept, reason } = req.body as {
    requestId: string;
    accept: boolean;
    reason?: string;
  };

  const driverId = req.user._id.toString();
  const handled = accept
    ? await acceptOffer(requestId, driverId)
    : await declineOffer(requestId, driverId, reason);

  if (!handled) {
    // Almost always a race: the offer timed out or the caller cancelled while
    // the crew was reading it.
    throw ApiError.conflict('That dispatch offer is no longer available');
  }

  const doc = await EmergencyRequest.findById(requestId).populate(
    REQUEST_POPULATION as unknown as string[],
  );
  res.json({ accepted: accept, request: doc && accept ? serializeRequest(doc) : null });
});

export const advanceStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const body = req.body as {
    requestId: string;
    status: 'EN_ROUTE_TO_SCENE' | 'ON_SCENE' | 'TRANSPORTING' | 'ARRIVED_AT_HOSPITAL' | 'COMPLETED';
    destinationHospitalId?: string;
    note?: string;
  };

  const dto = await advanceRequestStatus({
    requestId: body.requestId,
    driverUserId: req.user._id.toString(),
    status: body.status,
    ...(body.destinationHospitalId ? { destinationHospitalId: body.destinationHospitalId } : {}),
    ...(body.note ? { note: body.note } : {}),
  });

  res.json({ request: dto });
});

/**
 * REST fallback for position updates. The socket channel is the normal path;
 * this exists for devices on networks that block WebSockets.
 */
export const pushLocation = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const result = await recordLocationPing(req.user._id.toString(), req.body as LocationPingInput);
  if (!result) throw ApiError.notFound('No ambulance is assigned to your account');

  res.json({ ok: true, ...result });
});
