/**
 * Coverage report for the served area.
 *
 * Answers the question a service is actually judged on: from anywhere a call
 * could come from, how far away is the nearest ambulance that can take it?
 *
 * Samples the service area on a fine grid and reports the average and the worst
 * case, both for any vehicle and for one capable of an advanced life support
 * call -- because a cardiac or stroke call cannot be given a basic vehicle, so
 * the distance that matters is to a *suitable* ambulance, not just a near one.
 *
 *   npm run coverage
 */

import { haversineMetres, vehicleMeets, type AmbulanceType, type LatLng } from '@sas/shared';
import { buildFleet, COVERAGE, FLEET_SIZE } from './fleet.js';

const SAMPLES_PER_AXIS = 60;

const LANDMARKS: Array<[string, LatLng]> = [
  ['Charminar', { lat: 17.3616, lng: 78.4747 }],
  ['HITEC City', { lat: 17.4435, lng: 78.3772 }],
  ['Secunderabad', { lat: 17.4344, lng: 78.5013 }],
  ['LB Nagar', { lat: 17.3457, lng: 78.551 }],
  ['Gachibowli', { lat: 17.4401, lng: 78.3489 }],
  ['Banjara Hills', { lat: 17.4156, lng: 78.4347 }],
  ['Uppal', { lat: 17.4058, lng: 78.559 }],
  ['Kukatpally', { lat: 17.4849, lng: 78.4138 }],
];

const fleet = buildFleet();

function nearestMetres(point: LatLng, accepts: (type: AmbulanceType) => boolean): number {
  let best = Infinity;
  for (const crew of fleet) {
    if (accepts(crew.type)) best = Math.min(best, haversineMetres(point, crew.patrol));
  }
  return best;
}

const anyVehicle = (): boolean => true;
const advanced = (type: AmbulanceType): boolean => vehicleMeets(type, 'ALS');

let worstAny = 0;
let worstAdvanced = 0;
let worstAnyAt: LatLng = { lat: 0, lng: 0 };
let worstAdvancedAt: LatLng = { lat: 0, lng: 0 };
let totalAny = 0;
let samples = 0;

for (let row = 0; row <= SAMPLES_PER_AXIS; row += 1) {
  for (let column = 0; column <= SAMPLES_PER_AXIS; column += 1) {
    const point: LatLng = {
      lat: COVERAGE.latMin + (COVERAGE.latMax - COVERAGE.latMin) * (row / SAMPLES_PER_AXIS),
      lng: COVERAGE.lngMin + (COVERAGE.lngMax - COVERAGE.lngMin) * (column / SAMPLES_PER_AXIS),
    };

    const any = nearestMetres(point, anyVehicle);
    const als = nearestMetres(point, advanced);
    // The location of a gap matters as much as its size: a worst case at the
    // very corner of the service boundary is expected, one in the middle of
    // the city is a hole that needs a vehicle moved.
    if (any > worstAny) {
      worstAny = any;
      worstAnyAt = point;
    }
    if (als > worstAdvanced) {
      worstAdvanced = als;
      worstAdvancedAt = point;
    }
    totalAny += any;
    samples += 1;
  }
}

const km = (metres: number): string => `${(metres / 1000).toFixed(2)} km`;

/** Names a point by the nearest landmark, and says when it is on the boundary. */
function describe(point: LatLng): string {
  let closest = LANDMARKS[0]!;
  let best = Infinity;
  for (const landmark of LANDMARKS) {
    const distance = haversineMetres(point, landmark[1]);
    if (distance < best) {
      best = distance;
      closest = landmark;
    }
  }

  const onEdge =
    Math.min(
      Math.abs(point.lat - COVERAGE.latMin),
      Math.abs(point.lat - COVERAGE.latMax),
      Math.abs(point.lng - COVERAGE.lngMin),
      Math.abs(point.lng - COVERAGE.lngMax),
    ) < 1e-6;

  return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)} (${km(best)} from ${closest[0]})${
    onEdge ? ', on the service boundary' : ''
  }`;
}
const byType = fleet.reduce<Record<string, number>>(
  (counts, crew) => ({ ...counts, [crew.type]: (counts[crew.type] ?? 0) + 1 }),
  {},
);

const lines = [
  '',
  `Fleet coverage across the Hyderabad service area (${FLEET_SIZE} vehicles)`,
  '='.repeat(64),
  `  Composition        ${Object.entries(byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')}`,
  `  Sampled at         ${samples.toLocaleString()} points`,
  '',
  `  Nearest ambulance  average ${km(totalAny / samples)}, worst case ${km(worstAny)}`,
  `                     worst at ${describe(worstAnyAt)}`,
  `  Nearest ALS+       worst case ${km(worstAdvanced)}`,
  `                     worst at ${describe(worstAdvancedAt)}`,
  '',
  '  At specific places:',
  ...LANDMARKS.map(([name, point]) => {
    const any = km(nearestMetres(point, anyVehicle)).padStart(8);
    const als = km(nearestMetres(point, advanced)).padStart(8);
    return `    ${name.padEnd(15)} ${any} to nearest   ${als} to nearest ALS`;
  }),
  '='.repeat(64),
  '',
];

process.stdout.write(`${lines.join('\n')}\n`);
