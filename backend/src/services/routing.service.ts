/**
 * Road routing.
 *
 * Talks to an OSRM instance (the public demo server by default; point
 * `OSRM_BASE_URL` at your own for anything real) and falls back to a
 * straight-line estimate whenever routing is disabled, times out, or errors.
 *
 * The fallback matters more than the happy path: an ambulance dispatch must
 * never fail because a third-party routing service is slow. A slightly
 * optimistic ETA beats no ambulance.
 */

import { haversineMetres, type LatLng, type RouteDto } from '@sas/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Mean effective speed for the offline estimate, in metres per second.
 * 11 m/s (~40 km/h) reflects urban traffic with right of way, and the 1.3
 * detour factor accounts for roads not being straight lines.
 */
const FALLBACK_SPEED_MPS = 11;
const DETOUR_FACTOR = 1.3;

/** Cache identical lookups briefly; a fleet often routes to the same scene. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; route: RouteDto }>();

/** Rounded to ~11 m so tiny GPS jitter still hits the same cache entry. */
function cacheKey(from: LatLng, to: LatLng): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(from.lat)},${r(from.lng)}|${r(to.lat)},${r(to.lng)}`;
}

function readCache(key: string): RouteDto | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.route;
}

function writeCache(key: string, route: RouteDto): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), route });
}

/**
 * Decodes an encoded polyline (Google/OSRM format, precision 5) into points.
 * Implemented here rather than pulled in as a dependency: it is twenty lines
 * and the format has not changed in fifteen years.
 */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;
}

export function straightLineRoute(from: LatLng, to: LatLng): RouteDto {
  const direct = haversineMetres(from, to);
  const distanceMetres = direct * DETOUR_FACTOR;
  return {
    points: [from, to],
    distanceMetres: Math.round(distanceMetres),
    durationSeconds: Math.round(distanceMetres / FALLBACK_SPEED_MPS),
    source: 'straight-line',
  };
}

interface OsrmResponse {
  code?: string;
  routes?: Array<{ geometry?: string; distance?: number; duration?: number }>;
}

/**
 * Best available route between two points. Never throws: on any failure it
 * returns the straight-line estimate and logs the reason.
 */
export async function getRoute(from: LatLng, to: LatLng): Promise<RouteDto> {
  if (!env.ROUTING_ENABLED) return straightLineRoute(from, to);

  const key = cacheKey(from, to);
  const cached = readCache(key);
  if (cached) return cached;

  const url =
    `${env.OSRM_BASE_URL}/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=polyline&alternatives=false&steps=false`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ROUTING_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'smart-ambulance-dispatch/1.0' },
    });
    if (!response.ok) throw new Error(`OSRM responded ${response.status}`);

    const body = (await response.json()) as OsrmResponse;
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best?.geometry) throw new Error(`OSRM code ${body.code ?? 'unknown'}`);

    const route: RouteDto = {
      points: decodePolyline(best.geometry),
      distanceMetres: Math.round(best.distance ?? 0),
      durationSeconds: Math.round(best.duration ?? 0),
      source: 'osrm',
    };
    writeCache(key, route);
    return route;
  } catch (error) {
    logger.debug({ err: error }, 'Routing lookup failed; using straight-line estimate');
    const fallback = straightLineRoute(from, to);
    // Cached too, so one slow OSRM call does not stall every later request.
    writeCache(key, fallback);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Travel time only, for ranking many candidate vehicles. Uses the straight-line
 * estimate deliberately: asking a routing server for a full route per candidate
 * would add seconds to a dispatch decision that must happen in milliseconds.
 */
export function estimateSeconds(from: LatLng, to: LatLng): number {
  return straightLineRoute(from, to).durationSeconds;
}

/**
 * Emergency vehicles travel faster than the routing profile assumes, because of
 * right of way and lights-and-sirens. Applying a correction keeps the ETA shown
 * to the patient honest rather than pessimistic.
 */
const EMERGENCY_SPEED_FACTOR = 0.78;

export function applyEmergencyFactor(durationSeconds: number): number {
  return Math.max(30, Math.round(durationSeconds * EMERGENCY_SPEED_FACTOR));
}

/** Test seam: clears the memoised routes between suites. */
export function resetRouteCache(): void {
  cache.clear();
}
