/**
 * A fleet the server drives itself.
 *
 * The simulator in `scripts/simulate.ts` is an external API client, which is
 * the honest way to exercise the system: it proves a real crew device can do
 * everything it does. But it has to run somewhere, and a demonstration
 * deployment whose ambulances only move while a laptop is open is not much of
 * a demonstration -- close the laptop and every case stalls at "finding nearest
 * ambulance" with a fleet that looks available and answers nothing.
 *
 * This runs the same behaviour inside the API process: crews come on duty,
 * accept the cases offered to them, drive the route and hand the patient over.
 * It calls the ordinary services rather than the HTTP API, so it costs a
 * fraction of what a hundred websocket clients and their sign-ins would -- the
 * difference between something a free instance can serve and something it
 * cannot.
 *
 * Off unless `DEMO_FLEET_SIZE` is set. A real deployment has real crews.
 */

import { haversineMetres, interpolate, toLatLng, type LatLng } from '@sas/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Ambulance, EmergencyRequest, type AmbulanceDocument } from '../models/index.js';
import { acceptOffer } from './dispatch.service.js';
import { advanceRequestStatus } from './request.service.js';
import { recordLocationPing } from './tracking.service.js';

/** Metres per second while responding: about 47 km/h through a city. */
const RESPONSE_SPEED_MPS = 13;
/** A slow drift while idle, so the map is alive without vehicles racing. */
const IDLE_SPEED_MPS = 1.5;
/** Close enough to count as arrived. */
const ARRIVAL_RADIUS_METRES = 60;
/** How far a vehicle wanders from its patrol point before turning back. */
const WANDER_RADIUS_METRES = 1200;
/**
 * Seconds between ticks. Two rather than one: position is interpolated on the
 * map anyway, and halving the tick rate halves the database writes on an
 * instance that does not have much CPU to spare.
 */
const TICK_MS = 2000;
/** How long a crew spends with the patient before setting off. */
const ON_SCENE_MS = 25_000;
/** And at the hospital, before closing the case. */
const HANDOVER_MS = 8000;

interface DemoCrew {
  ambulanceId: string;
  driverId: string;
  vehicleNumber: string;
  base: LatLng;
  position: LatLng;
  /** Remaining waypoints of the route being driven. */
  path: LatLng[];
  /** Where the current leg ends. */
  destination: LatLng | null;
  requestId: string | null;
  /** Set while the crew is deliberately stationary, e.g. treating a patient. */
  waitingUntil: number;
}

const crews = new Map<string, DemoCrew>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Picks vehicles spread across the fleet rather than the first N.
 *
 * Vehicles are created in patrol-grid order, so taking the front of the list
 * would crew one contiguous corner of the city and leave everywhere else with
 * ambulances that cannot answer.
 */
function everyNth<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]!);
}

function toCrew(vehicle: AmbulanceDocument): DemoCrew | null {
  const base = toLatLng(vehicle.baseLocation) ?? toLatLng(vehicle.location);
  if (!base) return null;

  return {
    ambulanceId: vehicle._id.toString(),
    driverId: vehicle.driver.toString(),
    vehicleNumber: vehicle.vehicleNumber,
    base,
    position: toLatLng(vehicle.location) ?? base,
    path: [],
    destination: null,
    requestId: vehicle.activeRequest?.toString() ?? null,
    waitingUntil: 0,
  };
}

/** Moves a point towards a target, returning how far short it still is. */
function step(from: LatLng, to: LatLng, metres: number): LatLng {
  const distance = haversineMetres(from, to);
  if (distance <= metres) return to;
  return interpolate(from, to, metres / distance);
}

/** Advances along the waypoint list, consuming segments as they are passed. */
function followPath(crew: DemoCrew, metres: number): void {
  let remaining = metres;

  while (remaining > 0 && crew.path.length > 0) {
    const target = crew.path[0];
    if (!target) break;

    const distance = haversineMetres(crew.position, target);
    if (distance <= remaining) {
      crew.position = target;
      remaining -= distance;
      crew.path.shift();
    } else {
      crew.position = interpolate(crew.position, target, remaining / distance);
      remaining = 0;
    }
  }

  // Road routes end at the nearest road, which can be tens of metres from the
  // destination; close that last gap directly.
  if (crew.path.length === 0 && crew.destination && remaining > 0) {
    crew.position = step(crew.position, crew.destination, remaining);
  }
}

/** Idle drift: a slow random walk that stays near the patrol point. */
function wander(crew: DemoCrew, metres: number): void {
  const degreesPerMetre = 1 / 111_320;
  const angle = Math.random() * Math.PI * 2;
  const candidate: LatLng = {
    lat: crew.position.lat + Math.sin(angle) * metres * degreesPerMetre,
    lng:
      crew.position.lng +
      (Math.cos(angle) * metres * degreesPerMetre) / Math.cos((crew.position.lat * Math.PI) / 180),
  };

  crew.position =
    haversineMetres(crew.base, candidate) > WANDER_RADIUS_METRES
      ? interpolate(crew.position, crew.base, 0.1)
      : candidate;
}

/** Takes the case the dispatcher is offering this crew, if there is one. */
async function acceptAnyOffer(crew: DemoCrew): Promise<void> {
  const offered = await EmergencyRequest.findOne({
    status: 'SEARCHING',
    dispatchAttempts: { $elemMatch: { ambulance: crew.ambulanceId, outcome: 'PENDING' } },
  }).select('_id');
  if (!offered) return;

  const requestId = offered._id.toString();
  if (await acceptOffer(requestId, crew.driverId)) {
    crew.requestId = requestId;
    crew.path = [];
    crew.destination = null;
    logger.info({ vehicle: crew.vehicleNumber, requestId }, 'Demo crew accepted a case');
  }
}

/**
 * Works the current case one tick further: drives towards whatever the crew is
 * heading for, and advances the case when it arrives.
 */
async function workCase(crew: DemoCrew, metresThisTick: number): Promise<void> {
  if (Date.now() < crew.waitingUntil) return;

  const request = await EmergencyRequest.findById(crew.requestId);
  if (!request) {
    crew.requestId = null;
    return;
  }

  switch (request.status) {
    case 'ASSIGNED':
      await advanceRequestStatus({
        requestId: crew.requestId!,
        driverUserId: crew.driverId,
        status: 'EN_ROUTE_TO_SCENE',
      });
      return;

    case 'EN_ROUTE_TO_SCENE':
    case 'TRANSPORTING': {
      const heading = request.status === 'TRANSPORTING';
      const target = heading
        ? // The destination hospital's position rides along on the route the
          // dispatcher already computed; its last point is close enough.
          (request.route?.points?.at(-1) ?? null)
        : toLatLng(request.pickup);
      if (!target) return;

      crew.destination = target;
      // Adopt the server's own route so the vehicle follows streets rather
      // than cutting across the city.
      if (crew.path.length === 0 && (request.route?.points?.length ?? 0) > 2) {
        crew.path = [...request.route!.points];
      }

      followPath(crew, metresThisTick);

      if (haversineMetres(crew.position, target) <= ARRIVAL_RADIUS_METRES) {
        crew.path = [];
        crew.destination = null;
        if (heading) {
          await advanceRequestStatus({
            requestId: crew.requestId!,
            driverUserId: crew.driverId,
            status: 'ARRIVED_AT_HOSPITAL',
          });
          crew.waitingUntil = Date.now() + HANDOVER_MS;
        } else {
          await advanceRequestStatus({
            requestId: crew.requestId!,
            driverUserId: crew.driverId,
            status: 'ON_SCENE',
          });
          crew.waitingUntil = Date.now() + ON_SCENE_MS;
        }
      }
      return;
    }

    case 'ON_SCENE': {
      if (!request.hospital) {
        await advanceRequestStatus({
          requestId: crew.requestId!,
          driverUserId: crew.driverId,
          status: 'COMPLETED',
        });
        crew.requestId = null;
        return;
      }
      await advanceRequestStatus({
        requestId: crew.requestId!,
        driverUserId: crew.driverId,
        status: 'TRANSPORTING',
        destinationHospitalId: request.hospital.toString(),
      });
      crew.path = [];
      return;
    }

    case 'ARRIVED_AT_HOSPITAL':
      await advanceRequestStatus({
        requestId: crew.requestId!,
        driverUserId: crew.driverId,
        status: 'COMPLETED',
      });
      crew.requestId = null;
      crew.base = { ...crew.position };
      return;

    default:
      // Completed, cancelled, or otherwise no longer this crew's problem.
      crew.requestId = null;
      crew.path = [];
      crew.destination = null;
  }
}

async function tick(): Promise<void> {
  // Ticks must not overlap: a slow database round trip would otherwise stack
  // them up and move every vehicle twice.
  if (ticking) return;
  ticking = true;

  try {
    for (const crew of crews.values()) {
      try {
        if (!crew.requestId) await acceptAnyOffer(crew);

        const metres = (crew.requestId ? RESPONSE_SPEED_MPS : IDLE_SPEED_MPS) * (TICK_MS / 1000);

        if (crew.requestId) await workCase(crew, metres);
        else wander(crew, metres);

        await recordLocationPing(crew.driverId, {
          lat: crew.position.lat,
          lng: crew.position.lng,
        });
      } catch (error) {
        logger.debug({ err: error, vehicle: crew.vehicleNumber }, 'Demo crew tick failed');
      }
    }
  } finally {
    ticking = false;
  }
}

/** Brings a slice of the fleet on duty and starts driving it. */
export async function startDemoFleet(): Promise<void> {
  const size = env.DEMO_FLEET_SIZE;
  if (size <= 0) return;

  const vehicles = await Ambulance.find({ isActive: true }).sort({ vehicleNumber: 1 });
  if (vehicles.length === 0) {
    logger.warn(
      'DEMO_FLEET_SIZE is set but there are no ambulances; has the database been seeded?',
    );
    return;
  }

  const chosen = everyNth(vehicles, size);

  for (const vehicle of chosen) {
    const crew = toCrew(vehicle);
    if (!crew) continue;

    // Only bring a vehicle on duty if it is not already committed to
    // something; a restart mid-case should resume, not reset.
    if (vehicle.status === 'OFFLINE') {
      vehicle.status = 'AVAILABLE';
      vehicle.lastSeenAt = new Date();
      await vehicle.save();
    }
    crews.set(crew.ambulanceId, crew);
  }

  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  logger.info(
    { crews: crews.size, of: vehicles.length },
    'Demo fleet on duty - this deployment drives its own ambulances',
  );
}

export function stopDemoFleet(): void {
  if (timer) clearInterval(timer);
  timer = null;
  crews.clear();
}
