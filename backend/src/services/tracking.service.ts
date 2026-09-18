/**
 * Live vehicle tracking.
 *
 * Every GPS ping from a crew device lands here, whether it arrived over the
 * socket or the REST fallback. The ping updates the vehicle, fans out to
 * everyone watching, and -- at a much lower rate -- triggers a re-route.
 *
 * Rate discipline is the whole point of this module. A fleet of 200 vehicles
 * pinging every two seconds is 100 writes a second; re-routing on each one
 * would mean 100 calls a second to the routing engine. So positions are written
 * and broadcast on every ping, and the ETA is recomputed only when the vehicle
 * has actually moved a meaningful distance or enough time has passed.
 */

import {
  bearingDegrees,
  haversineMetres,
  toLatLng,
  type AmbulancePositionEvent,
  type LocationPingInput,
} from '@sas/shared';
import { logger } from '../config/logger.js';
import { Ambulance, type AmbulanceDocument } from '../models/index.js';
import { refreshEta } from './dispatch.service.js';
import { realtime } from './realtime.service.js';

/** Re-route at most this often per case, however fast the pings arrive. */
const ETA_MIN_INTERVAL_MS = 12_000;
/** ...or sooner, once the vehicle has covered this much ground. */
const ETA_MIN_MOVEMENT_METRES = 250;
/** Pings that claim to be further than this from the last fix are ignored. */
const IMPLAUSIBLE_JUMP_METRES = 20_000;

interface EtaMarker {
  at: number;
  lat: number;
  lng: number;
}

const lastEtaRefresh = new Map<string, EtaMarker>();

function shouldRefreshEta(requestId: string, lat: number, lng: number): boolean {
  const previous = lastEtaRefresh.get(requestId);
  const now = Date.now();

  if (!previous) {
    lastEtaRefresh.set(requestId, { at: now, lat, lng });
    return true;
  }

  const movedMetres = haversineMetres({ lat: previous.lat, lng: previous.lng }, { lat, lng });
  const elapsedMs = now - previous.at;

  if (elapsedMs >= ETA_MIN_INTERVAL_MS || movedMetres >= ETA_MIN_MOVEMENT_METRES) {
    lastEtaRefresh.set(requestId, { at: now, lat, lng });
    return true;
  }
  return false;
}

export interface TrackingResult {
  ambulanceId: string;
  status: AmbulanceDocument['status'];
  requestId: string | null;
}

/**
 * Applies a position update for the vehicle this driver crews.
 * Returns null when the driver has no vehicle assigned to them.
 */
export async function recordLocationPing(
  driverUserId: string,
  ping: LocationPingInput,
): Promise<TrackingResult | null> {
  const vehicle = await Ambulance.findOne({ driver: driverUserId, isActive: true });
  if (!vehicle) return null;

  const previous = toLatLng(vehicle.location);
  const next = { lat: ping.lat, lng: ping.lng };

  if (previous) {
    const jump = haversineMetres(previous, next);
    if (jump > IMPLAUSIBLE_JUMP_METRES) {
      // Almost always a bad fix from a device that has just woken up. Accepting
      // it would teleport the vehicle across the map and wreck the ETA.
      logger.warn(
        { vehicle: vehicle.vehicleNumber, jumpMetres: Math.round(jump) },
        'Ignoring implausible GPS jump',
      );
      return {
        ambulanceId: vehicle._id.toString(),
        status: vehicle.status,
        requestId: vehicle.activeRequest?.toString() ?? null,
      };
    }
  }

  // Devices often omit heading when stationary; derive it from the track.
  const heading =
    ping.heading ?? (previous && haversineMetres(previous, next) > 5
      ? bearingDegrees(previous, next)
      : vehicle.heading);

  vehicle.location = { type: 'Point', coordinates: [ping.lng, ping.lat] };
  vehicle.heading = Math.round(heading);
  vehicle.speedMps = ping.speed ?? 0;
  vehicle.lastSeenAt = new Date();
  await vehicle.save();

  const requestId = vehicle.activeRequest?.toString() ?? null;

  const event: AmbulancePositionEvent = {
    ambulanceId: vehicle._id.toString(),
    vehicleNumber: vehicle.vehicleNumber,
    status: vehicle.status,
    location: next,
    heading: vehicle.heading,
    speedMps: vehicle.speedMps,
    at: vehicle.lastSeenAt.toISOString(),
    requestId,
  };
  realtime.ambulancePosition(event);

  if (requestId && shouldRefreshEta(requestId, ping.lat, ping.lng)) {
    // Detached: a slow routing call must never delay the next position ping.
    void refreshEta(requestId).catch((error: unknown) => {
      logger.debug({ err: error, requestId }, 'ETA refresh failed');
    });
  }

  return { ambulanceId: vehicle._id.toString(), status: vehicle.status, requestId };
}

/** Drops throttling state for a case once it closes. */
export function forgetRequestTracking(requestId: string): void {
  lastEtaRefresh.delete(requestId);
}

export function resetTrackingState(): void {
  lastEtaRefresh.clear();
}
