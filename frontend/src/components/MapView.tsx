/**
 * The shared map.
 *
 * Every screen that shows geography uses this one component, differing only in
 * what it is handed. Keeping a single map implementation means the dark tile
 * treatment, the marker language and the auto-framing behave identically for a
 * patient watching one ambulance and for a control room watching forty.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AmbulanceDto, HospitalDto, LatLng, RouteDto } from '@sas/shared';
import { ambulanceIcon, hospitalIcon, patientIcon, ROUTE_COLOURS } from '../lib/mapIcons';
import { AMBULANCE_TYPE_LABELS } from '@sas/shared';
import { formatDistance, formatRelative } from '../lib/format';

export interface MapViewProps {
  centre?: LatLng;
  zoom?: number;
  ambulances?: AmbulanceDto[];
  hospitals?: HospitalDto[];
  patient?: LatLng | null;
  route?: RouteDto | null;
  /** Colours the route line for the leg being driven. */
  routeStage?: 'toScene' | 'toHospital';
  /** Re-frames the map whenever these points change. */
  fitTo?: LatLng[];
  /** Drawn larger and in the transport colour, when a destination is chosen. */
  destinationHospitalId?: string | null;
  focusedAmbulanceId?: string | null;
  className?: string;
  interactive?: boolean;
}

/** Hyderabad, the city this deployment serves. */
const DEFAULT_CENTRE: LatLng = { lat: 17.385, lng: 78.4867 };

/**
 * Keeps everything that matters in view.
 *
 * Deliberately only reacts to a change in the *set* of points, not to every
 * position tick: re-fitting on each GPS ping would leave the map permanently
 * animating and impossible to pan by hand.
 */
function AutoFit({ points }: { points: LatLng[] }) {
  const map = useMap();
  const signature = points.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join('|');
  const lastSignature = useRef('');

  useEffect(() => {
    if (points.length === 0 || signature === lastSignature.current) return;
    lastSignature.current = signature;

    if (points.length === 1) {
      const only = points[0];
      if (only) map.setView([only.lat, only.lng], Math.max(map.getZoom(), 14), { animate: true });
      return;
    }

    const bounds = L.latLngBounds(
      points.map((point) => [point.lat, point.lng] as [number, number]),
    );
    map.fitBounds(bounds, { padding: [56, 56], maxZoom: 16, animate: true });
  }, [map, signature, points]);

  return null;
}

/** Leaflet caches its size on mount; a panel that resizes needs a nudge. */
function ResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const invalidate = (): void => {
      map.invalidateSize();
    };
    // Once after layout has settled, then on every container resize.
    const timer = window.setTimeout(invalidate, 180);
    const observer = new ResizeObserver(invalidate);
    observer.observe(map.getContainer());

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [map]);

  return null;
}

export function MapView({
  centre = DEFAULT_CENTRE,
  zoom = 13,
  ambulances = [],
  hospitals = [],
  patient = null,
  route = null,
  routeStage = 'toScene',
  fitTo,
  destinationHospitalId = null,
  focusedAmbulanceId = null,
  className = '',
  interactive = true,
}: MapViewProps) {
  const routePoints = useMemo(
    () => (route?.points ?? []).map((point) => [point.lat, point.lng] as [number, number]),
    [route],
  );

  const framePoints = useMemo<LatLng[]>(() => {
    if (fitTo) return fitTo;
    const points: LatLng[] = [];
    if (patient) points.push(patient);
    for (const vehicle of ambulances) if (vehicle.location) points.push(vehicle.location);
    return points;
  }, [fitTo, patient, ambulances]);

  return (
    <div className={`map-dark relative ${className}`}>
      <MapContainer
        center={[centre.lat, centre.lng]}
        zoom={zoom}
        className="h-full w-full"
        // Placed explicitly below, out of the way of the screens that float a
        // status badge over the map's top-left corner.
        zoomControl={false}
        dragging={interactive}
        scrollWheelZoom={interactive}
        doubleClickZoom={interactive}
        attributionControl
      >
        {interactive && <ZoomControl position="topright" />}

        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />

        <ResizeHandler />
        <AutoFit points={framePoints} />

        {routePoints.length > 1 && (
          <>
            {/* A wide, faint underlay makes the route readable over dense streets. */}
            <Polyline
              positions={routePoints}
              pathOptions={{ color: ROUTE_COLOURS[routeStage], weight: 11, opacity: 0.16 }}
            />
            <Polyline
              positions={routePoints}
              pathOptions={{ color: ROUTE_COLOURS[routeStage], weight: 4, opacity: 0.95 }}
            />
          </>
        )}

        {hospitals.map((hospital) => (
          <Marker
            key={hospital.id}
            position={[hospital.location.lat, hospital.location.lng]}
            icon={hospitalIcon(hospital.id === destinationHospitalId)}
          >
            <Popup>
              <div className="min-w-[180px]">
                <p className="text-sm font-semibold text-ink-100">{hospital.name}</p>
                <p className="mt-0.5 text-xs text-ink-300">{hospital.address}</p>
                <p className="mt-2 text-xs text-ink-200">
                  <span className="font-semibold text-emerald-300">{hospital.beds.available}</span>{' '}
                  of {hospital.beds.total} beds free
                </p>
              </div>
            </Popup>
          </Marker>
        ))}

        {patient && (
          <Marker position={[patient.lat, patient.lng]} icon={patientIcon()} zIndexOffset={1000}>
            <Popup>
              <p className="text-sm font-semibold text-ink-100">Patient location</p>
            </Popup>
          </Marker>
        )}

        {ambulances.map((vehicle) =>
          vehicle.location ? (
            <Marker
              key={vehicle.id}
              position={[vehicle.location.lat, vehicle.location.lng]}
              icon={ambulanceIcon(
                vehicle.status,
                vehicle.heading,
                vehicle.id === focusedAmbulanceId,
              )}
              zIndexOffset={vehicle.id === focusedAmbulanceId ? 900 : 0}
            >
              <Popup>
                <div className="min-w-[190px]">
                  <p className="numeric text-sm font-bold text-ink-100">{vehicle.vehicleNumber}</p>
                  <p className="mt-0.5 text-xs text-ink-300">
                    {AMBULANCE_TYPE_LABELS[vehicle.type]}
                  </p>
                  <dl className="mt-2 space-y-1 text-xs">
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-400">Status</dt>
                      <dd className="font-semibold text-ink-100">{vehicle.status}</dd>
                    </div>
                    {vehicle.driver && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-ink-400">Crew</dt>
                        <dd className="text-ink-100">{vehicle.driver.name}</dd>
                      </div>
                    )}
                    {vehicle.distanceMetres !== undefined && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-ink-400">Distance</dt>
                        <dd className="text-ink-100">{formatDistance(vehicle.distanceMetres)}</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-400">Seen</dt>
                      <dd className="text-ink-100">{formatRelative(vehicle.lastSeenAt)}</dd>
                    </div>
                  </dl>
                </div>
              </Popup>
            </Marker>
          ) : null,
        )}
      </MapContainer>
    </div>
  );
}
