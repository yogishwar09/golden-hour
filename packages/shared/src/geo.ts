/**
 * Geospatial primitives. Coordinates follow the GeoJSON convention
 * `[longitude, latitude]` everywhere, including in MongoDB documents, so that
 * `2dsphere` indexes and `$near` queries work without any reordering.
 */

export interface GeoPoint {
  type: 'Point';
  /** `[longitude, latitude]` in decimal degrees (WGS 84). */
  coordinates: [number, number];
}

/** The shape front-end code prefers, because map libraries think in lat/lng. */
export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_METRES = 6_371_008.8;

export function toGeoPoint(input: LatLng): GeoPoint {
  return { type: 'Point', coordinates: [input.lng, input.lat] };
}

export function toLatLng(point: GeoPoint | null | undefined): LatLng | null {
  if (!point || !Array.isArray(point.coordinates)) return null;
  const [lng, lat] = point.coordinates;
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  return { lat, lng };
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres. Accurate to well under a percent at city
 * scale, which is all the dispatcher needs for a first-pass ranking before the
 * routing engine produces real road distances.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from true north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Point `fraction` of the way along the straight line from `a` to `b`. */
export function interpolate(a: LatLng, b: LatLng, fraction: number): LatLng {
  const t = Math.max(0, Math.min(1, fraction));
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '--';
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours} h ${totalMinutes % 60} min`;
}
