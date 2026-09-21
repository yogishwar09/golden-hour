/**
 * The patient screen.
 *
 * Two modes in one place: raise an emergency, or watch the one already running.
 * A caller in distress should never have to find the right page -- whatever
 * state their case is in, this is the screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Ambulance as AmbulanceIcon,
  Building2,
  CheckCircle2,
  Crosshair,
  Droplet,
  MapPin,
  Navigation,
  Phone,
  Siren,
  Star,
  X,
} from 'lucide-react';
import {
  EMERGENCY_TYPE_LABELS,
  EMERGENCY_TYPES,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  AMBULANCE_TYPE_LABELS,
  type AmbulanceDto,
  type EmergencyRequestDto,
  type EmergencyType,
  type HospitalDto,
  type LatLng,
  type MyStatsDto,
  type ServiceStatsDto,
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useGeolocation } from '../hooks/useGeolocation';
import { MapView } from '../components/MapView';
import { StatusTimeline } from '../components/StatusTimeline';
import {
  Card,
  ErrorNotice,
  FullPageLoader,
  SectionTitle,
  Skeleton,
  Spinner,
} from '../components/ui';
import {
  formatDistance,
  formatDurationShort,
  formatEta,
  PRIORITY_STYLES,
  REQUEST_STATUS_STYLES,
} from '../lib/format';

/**
 * How often the pre-SOS map re-reads nearby ambulances. Fast enough that the
 * fleet visibly moves, slow enough that a screen left open costs little.
 */
const NEARBY_REFRESH_MS = 4000;

/** Cases in these states are still running and own the screen. */
const LIVE_STATUSES = new Set([
  'PENDING',
  'SEARCHING',
  'ASSIGNED',
  'EN_ROUTE_TO_SCENE',
  'ON_SCENE',
  'TRANSPORTING',
  'ARRIVED_AT_HOSPITAL',
]);

export function PatientSOS() {
  const { user, socket } = useAuth();
  const geo = useGeolocation();

  const [activeCase, setActiveCase] = useState<EmergencyRequestDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [emergencyType, setEmergencyType] = useState<EmergencyType>('OTHER');
  const [notes, setNotes] = useState('');
  const [vitals, setVitals] = useState({
    conscious: true,
    breathing: true,
    bleedingSeverely: false,
  });
  const [confirming, setConfirming] = useState(false);

  const [nearby, setNearby] = useState<AmbulanceDto[]>([]);
  const [hospitals, setHospitals] = useState<HospitalDto[]>([]);

  /**
   * A point the caller placed by hand.
   *
   * Browsers refuse GPS outright if permission was once denied, and the refusal
   * is remembered -- which would otherwise leave the SOS button permanently
   * disabled with no way back. Dropping a pin is the fallback, and it takes
   * precedence when set because the caller knows better than the device.
   */
  const [manualPosition, setManualPosition] = useState<LatLng | null>(null);
  const [pickingLocation, setPickingLocation] = useState(false);

  /** A case that has just ended, held so its outcome can be shown. */
  const [finishedCase, setFinishedCase] = useState<EmergencyRequestDto | null>(null);
  const [serviceStats, setServiceStats] = useState<ServiceStatsDto | null>(null);
  const [myStats, setMyStats] = useState<MyStatsDto | null>(null);

  const position = manualPosition ?? geo.position;

  /** Load whatever case is already running for this caller. */
  useEffect(() => {
    api
      .get<{ request: EmergencyRequestDto | null }>('/emergency/active')
      .then((response) => setActiveCase(response.data.request))
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  }, []);

  /**
   * The service's record and the caller's own. Re-read whenever a case ends,
   * so the numbers a caller sees include the journey they just took.
   */
  useEffect(() => {
    const load = (): void => {
      void api
        .get<ServiceStatsDto>('/stats/service')
        .then((response) => setServiceStats(response.data))
        .catch(() => setServiceStats(null));
      void api
        .get<MyStatsDto>('/stats/me')
        .then((response) => setMyStats(response.data))
        .catch(() => setMyStats(null));
    };

    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [finishedCase]);

  /**
   * Show what is around the caller while they are deciding.
   *
   * The ambulances are re-read on a timer rather than pushed over the socket.
   * Position events are addressed to a case's room, the control room and the
   * vehicle's own room -- a caller who has not raised anything yet is in none
   * of those, and broadcasting the whole fleet to every signed-in patient to
   * animate a reassurance map would be the wrong trade. Once a case exists the
   * live socket takes over and this stops.
   *
   * Hospitals are fetched once: buildings do not move.
   */
  useEffect(() => {
    if (!position || activeCase) return;
    const params = { lat: position.lat, lng: position.lng, radiusKm: 12 };

    const loadAmbulances = (): void => {
      void api
        .get<{ items: AmbulanceDto[] }>('/ambulances/nearby', { params })
        .then((response) => setNearby(response.data.items))
        .catch(() => {
          /* Keep the last known positions rather than blanking the map. */
        });
    };

    loadAmbulances();
    const timer = window.setInterval(loadAmbulances, NEARBY_REFRESH_MS);

    void api
      .get<{ items: HospitalDto[] }>('/hospitals/nearby', { params: { ...params, limit: 8 } })
      .then((response) => setHospitals(response.data.items))
      .catch(() => setHospitals([]));

    return () => window.clearInterval(timer);
  }, [position, activeCase]);

  // Follow the case's own room, so updates arrive without polling. Keyed on the
  // id alone: re-subscribing on every field change would churn the room.
  const activeCaseId = activeCase?.id ?? null;
  useEffect(() => {
    if (!socket || !activeCaseId) return;
    socket.emit('request:subscribe', { requestId: activeCaseId });
    return () => {
      socket.emit('request:unsubscribe', { requestId: activeCaseId });
    };
  }, [socket, activeCaseId]);

  useSocketEvent('request:updated', (updated) => {
    setActiveCase((previous) => {
      if (previous && previous.id !== updated.id) return previous;
      if (LIVE_STATUSES.has(updated.status)) return updated;
      // The case has ended. Hold onto it so the caller gets an outcome rather
      // than the screen silently reverting to the SOS button.
      setFinishedCase(updated);
      return null;
    });
  });

  useSocketEvent('request:created', (created) => {
    setFinishedCase(null);
    setActiveCase(created);
  });

  useSocketEvent('request:status', (event) => {
    setActiveCase((previous) => {
      if (!previous || previous.id !== event.requestId) return previous;
      if (!LIVE_STATUSES.has(event.status)) {
        // `request:updated` carries the full case and will populate the
        // summary; this only has to clear the live view.
        setFinishedCase((already) => already ?? { ...previous, status: event.status });
        return null;
      }
      return { ...previous, status: event.status };
    });
  });

  useSocketEvent('request:eta', (event) => {
    setActiveCase((previous) =>
      previous && previous.id === event.requestId
        ? { ...previous, etaSeconds: event.etaSeconds, route: event.route ?? previous.route }
        : previous,
    );
  });

  // The vehicle's own position arrives far more often than a full case update,
  // so it is merged into the case's ambulance rather than refetching.
  useSocketEvent('ambulance:position', (event) => {
    setActiveCase((previous) => {
      if (!previous?.ambulance || previous.ambulance.id !== event.ambulanceId) return previous;
      return {
        ...previous,
        ambulance: {
          ...previous.ambulance,
          location: event.location,
          heading: event.heading,
          speedMps: event.speedMps,
          lastSeenAt: event.at,
        },
      };
    });
  });

  const raiseEmergency = useCallback(async (): Promise<void> => {
    if (!position) {
      setError('We need your location before an ambulance can be sent.');
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const response = await api.post<{ request: EmergencyRequestDto }>('/emergency', {
        emergencyType,
        pickup: position,
        notes: notes.trim() || undefined,
        vitals,
      });
      setActiveCase(response.data.request);
      setConfirming(false);
      toast.success('Emergency raised. Finding the nearest ambulance.');
    } catch (caught) {
      setError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }, [position, emergencyType, notes, vitals]);

  const cancelCase = useCallback(async (): Promise<void> => {
    if (!activeCase) return;
    const reason = window.prompt('Why are you cancelling?', 'No longer needed');
    if (!reason) return;

    try {
      await api.post(`/emergency/${activeCase.id}/cancel`, { reason });
      setActiveCase(null);
      toast.success('Your request has been cancelled.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [activeCase]);

  if (loading) return <FullPageLoader label="Checking for an active request" />;

  if (activeCase) return <LiveCase caseData={activeCase} onCancel={cancelCase} />;

  if (finishedCase) {
    return (
      <CaseOutcome caseData={finishedCase} myStats={myStats} onDone={() => setFinishedCase(null)} />
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <div className="space-y-5">
        <ServiceStatsStrip stats={serviceStats} myStats={myStats} />

        <Card className="overflow-hidden">
          <div className="border-b border-ink-700 bg-gradient-to-br from-emergency-950/40 to-transparent px-6 py-5">
            <h1 className="text-xl font-bold tracking-tight">Hello, {user?.name.split(' ')[0]}</h1>
            <p className="mt-0.5 text-sm text-ink-400">
              Press the button and stay on this screen. Help is dispatched automatically.
            </p>
          </div>

          <div className="flex flex-col items-center px-6 py-8">
            <SosButton
              disabled={!position || submitting}
              busy={submitting}
              onPress={() => setConfirming(true)}
            />

            {/* The button is the only way to request an ambulance, and a large
                red circle does not say so on its own. This is the caption that
                tells a first-time caller what it does, and what is missing
                when it will not respond. */}
            <p className="mt-5 text-center text-sm font-semibold text-ink-200">
              {position ? (
                <>
                  Press <span className="text-emergency-300">SOS</span> to request an ambulance
                </>
              ) : (
                'Set your location first, then press SOS'
              )}
            </p>

            <div className="mt-4 w-full space-y-2">
              {/* The GPS error is only worth showing while there is no usable
                  position at all; once a pin is dropped it is just noise. */}
              {geo.error && !position && <ErrorNotice message={geo.error} />}
              {error && <ErrorNotice message={error} />}

              {pickingLocation && (
                <div className="flex items-start gap-2.5 rounded-xl border border-sky-700/50 bg-sky-950/40 px-3.5 py-3 text-sm text-sky-200">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>Click the map to mark where you are.</span>
                </div>
              )}

              <div className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-900/60 px-3.5 py-2.5">
                <span className="flex items-center gap-2 text-sm text-ink-300">
                  <Crosshair
                    className={`h-4 w-4 ${position ? 'text-emerald-400' : 'text-amber-400'}`}
                    aria-hidden
                  />
                  {manualPosition
                    ? 'Location set on the map'
                    : geo.loading
                      ? 'Finding your location'
                      : geo.position
                        ? `Located to ${Math.round(geo.accuracy ?? 0)} m`
                        : 'Location unavailable'}
                </span>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPickingLocation((on) => !on)}
                    className="btn-ghost px-2 py-1 text-xs"
                  >
                    {pickingLocation ? 'Done' : manualPosition ? 'Move pin' : 'Set on map'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // Hand control back to the device.
                      setManualPosition(null);
                      setPickingLocation(false);
                      geo.refresh();
                    }}
                    className="btn-ghost px-2 py-1 text-xs"
                  >
                    Use GPS
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>What is happening?</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {EMERGENCY_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setEmergencyType(type)}
                className={`rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition-colors ${
                  emergencyType === type
                    ? 'border-emergency-500 bg-emergency-500/10 text-emergency-200'
                    : 'border-ink-700 bg-ink-900/50 text-ink-300 hover:border-ink-600 hover:text-ink-100'
                }`}
              >
                {EMERGENCY_TYPE_LABELS[type]}
              </button>
            ))}
          </div>

          <div className="mt-5 space-y-2">
            <p className="label">Patient condition</p>
            {(
              [
                ['conscious', 'Conscious', true],
                ['breathing', 'Breathing normally', true],
                ['bleedingSeverely', 'Bleeding severely', false],
              ] as const
            ).map(([key, label, goodWhenTrue]) => {
              const value = vitals[key];
              const isAlarming = value !== goodWhenTrue;
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-between rounded-xl border border-ink-700 bg-ink-900/50 px-3.5 py-2.5"
                >
                  <span
                    className={`text-sm font-medium ${isAlarming ? 'text-emergency-300' : 'text-ink-200'}`}
                  >
                    {label}
                  </span>
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(event) =>
                      setVitals((previous) => ({ ...previous, [key]: event.target.checked }))
                    }
                    className="h-4 w-4 accent-emergency-500"
                  />
                </label>
              );
            })}
          </div>

          <div className="mt-4">
            <label className="label" htmlFor="sos-notes">
              Anything the crew should know?
            </label>
            <textarea
              id="sos-notes"
              className="input min-h-[72px] resize-y text-sm"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Flat 3, second floor. Gate code 1420."
              maxLength={1000}
            />
          </div>
        </Card>
      </div>

      <Card className="min-h-[420px] overflow-hidden p-0 lg:min-h-0">
        <MapView
          className="h-full min-h-[420px] w-full"
          centre={position ?? undefined}
          patient={position}
          ambulances={nearby}
          hospitals={hospitals}
          onSelectLocation={
            pickingLocation
              ? (point) => {
                  setManualPosition(point);
                  setPickingLocation(false);
                  setError(null);
                  toast.success('Location set. You can press SOS now.');
                }
              : undefined
          }
        />
      </Card>

      <AnimatePresence>
        {confirming && (
          <ConfirmDialog
            emergencyType={emergencyType}
            busy={submitting}
            onCancel={() => setConfirming(false)}
            onConfirm={raiseEmergency}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** The SOS control: a large, unmissable target with a living halo. */
function SosButton({
  onPress,
  disabled,
  busy,
}: {
  onPress: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <div className="relative flex h-52 w-52 items-center justify-center">
      {!disabled && (
        <>
          <span className="absolute h-40 w-40 animate-halo rounded-full bg-emergency-500" />
          <span className="absolute h-40 w-40 animate-halo-delayed rounded-full bg-emergency-500" />
        </>
      )}
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        aria-label="Request an ambulance now"
        className="relative flex h-40 w-40 flex-col items-center justify-center rounded-full
          bg-gradient-to-br from-emergency-500 to-emergency-700 text-white shadow-2xl
          shadow-emergency-900/60 ring-4 ring-emergency-500/20 transition-transform
          hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed
          disabled:from-ink-600 disabled:to-ink-700 disabled:shadow-none disabled:ring-ink-700
          motion-safe:animate-breathe"
      >
        {busy ? (
          <Spinner className="h-10 w-10" />
        ) : (
          <>
            <Siren className="h-11 w-11" aria-hidden />
            <span className="mt-1.5 text-2xl font-extrabold tracking-wider">SOS</span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * What the service has done, above the SOS button.
 *
 * A caller deciding whether to press it is really asking "will anyone come?".
 * Answering with the service's actual record -- cases completed, crews free
 * right now, how fast it typically reaches people -- is a more honest answer
 * than a reassuring sentence, and it is live.
 */
function ServiceStatsStrip({
  stats,
  myStats,
}: {
  stats: ServiceStatsDto | null;
  myStats: MyStatsDto | null;
}) {
  if (!stats) return <Skeleton className="h-[92px]" />;

  const readiness =
    stats.ambulancesTotal > 0 ? stats.ambulancesAvailable / stats.ambulancesTotal : 0;

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-3 divide-x divide-ink-700">
        <div className="px-4 py-3.5 text-center">
          <p className="numeric text-2xl font-bold leading-none text-emerald-300">
            {stats.casesCompleted.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Cases resolved
          </p>
        </div>
        <div className="px-4 py-3.5 text-center">
          <p
            className={`numeric text-2xl font-bold leading-none ${
              readiness > 0.3
                ? 'text-sky-300'
                : readiness > 0
                  ? 'text-amber-300'
                  : 'text-emergency-300'
            }`}
          >
            {stats.ambulancesAvailable}
            <span className="text-sm font-medium text-ink-400">/{stats.ambulancesTotal}</span>
          </p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Crews ready
          </p>
        </div>
        <div className="px-4 py-3.5 text-center">
          <p className="numeric text-2xl font-bold leading-none text-ink-100">
            {formatDurationShort(stats.averageResponseSeconds)}
          </p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Avg response
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-700 px-4 py-2.5 text-xs text-ink-400">
        <span>{stats.hospitalsCovered} hospitals covered</span>
        {stats.activeNow > 0 && (
          <span className="flex items-center gap-1.5 text-emergency-300">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emergency-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emergency-500" />
            </span>
            {stats.activeNow} live now
          </span>
        )}
        {stats.slaComplianceRate !== null && (
          <span>{Math.round(stats.slaComplianceRate * 100)}% within target</span>
        )}
        {myStats && myStats.totalRequests > 0 && (
          <span className="ml-auto text-ink-300">
            You: {myStats.totalRequests} request{myStats.totalRequests === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </Card>
  );
}

/**
 * The end of a case.
 *
 * Previously a completed case simply disappeared and the screen reverted to
 * the SOS button, which left a caller with no idea what had happened. This is
 * the receipt: where they were taken, how long it took, who took them, and the
 * one question worth asking afterwards.
 */
function CaseOutcome({
  caseData,
  myStats,
  onDone,
}: {
  caseData: EmergencyRequestDto;
  myStats: MyStatsDto | null;
  onDone: () => void;
}) {
  const [rating, setRating] = useState(caseData.rating?.stars ?? 0);
  const [rated, setRated] = useState(Boolean(caseData.rating));

  const completed = caseData.status === 'COMPLETED';
  const started = new Date(caseData.createdAt).getTime();
  const ended = new Date(caseData.updatedAt).getTime();
  const totalSeconds = Math.max(0, Math.round((ended - started) / 1000));

  const submitRating = async (stars: number): Promise<void> => {
    setRating(stars);
    try {
      await api.post(`/emergency/${caseData.id}/rate`, { stars });
      setRated(true);
      toast.success('Thank you for the feedback.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="overflow-hidden">
          <div
            className={`px-6 py-7 text-center ${
              completed
                ? 'bg-gradient-to-br from-emerald-950/50 to-transparent'
                : 'bg-gradient-to-br from-ink-800 to-transparent'
            }`}
          >
            <span
              className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${
                completed ? 'bg-emerald-500/15' : 'bg-ink-700'
              }`}
            >
              {completed ? (
                <CheckCircle2 className="h-7 w-7 text-emerald-300" aria-hidden />
              ) : (
                <X className="h-7 w-7 text-ink-300" aria-hidden />
              )}
            </span>

            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              {completed ? 'You reached hospital safely' : REQUEST_STATUS_LABELS[caseData.status]}
            </h1>
            <p className="mt-1 text-sm text-ink-400">
              Case {caseData.code} · {EMERGENCY_TYPE_LABELS[caseData.emergencyType]}
            </p>
          </div>

          {completed && (
            <div className="grid grid-cols-3 divide-x divide-ink-700 border-y border-ink-700">
              <div className="px-3 py-4 text-center">
                <p className="numeric text-xl font-bold text-emergency-300">
                  {formatDurationShort(caseData.responseSeconds)}
                </p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wider text-ink-400">
                  To reach you
                </p>
              </div>
              <div className="px-3 py-4 text-center">
                <p className="numeric text-xl font-bold text-ink-100">
                  {formatDurationShort(totalSeconds)}
                </p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wider text-ink-400">
                  Total journey
                </p>
              </div>
              <div className="px-3 py-4 text-center">
                <p className="numeric text-xl font-bold text-ink-100">{caseData.timeline.length}</p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wider text-ink-400">
                  Steps logged
                </p>
              </div>
            </div>
          )}

          <div className="space-y-4 px-6 py-5">
            {caseData.hospital && (
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-500/15">
                  <Building2 className="h-5 w-5 text-teal-300" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{caseData.hospital.name}</p>
                  <p className="truncate text-xs text-ink-400">{caseData.hospital.address}</p>
                </div>
              </div>
            )}

            {caseData.ambulance && (
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15">
                  <AmbulanceIcon className="h-5 w-5 text-sky-300" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="numeric text-sm font-semibold">
                    {caseData.ambulance.vehicleNumber}
                  </p>
                  <p className="truncate text-xs text-ink-400">
                    {caseData.ambulance.crew.map((member) => member.name).join(' · ') ||
                      AMBULANCE_TYPE_LABELS[caseData.ambulance.type]}
                  </p>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-ink-700 bg-ink-900/50 p-4">
              <StatusTimeline status={caseData.status} events={caseData.timeline} />
            </div>

            {completed && (
              <div className="text-center">
                <p className="label">{rated ? 'Your rating' : 'How did we do?'}</p>
                <div className="flex justify-center gap-1.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      disabled={rated}
                      onClick={() => submitRating(star)}
                      aria-label={`Rate ${star} out of 5`}
                      className="p-0.5 transition-transform enabled:hover:scale-110 disabled:cursor-default"
                    >
                      <Star
                        className={`h-8 w-8 ${
                          rating >= star ? 'fill-amber-400 text-amber-400' : 'text-ink-600'
                        }`}
                        aria-hidden
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {myStats && myStats.completed > 1 && (
              <p className="text-center text-xs text-ink-400">
                That is {myStats.completed} journeys this service has completed for you.
              </p>
            )}

            <button type="button" onClick={onDone} className="btn-primary w-full py-3">
              Done
            </button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

/**
 * A deliberate confirmation step. The button is large and easy to hit by
 * accident, and a false dispatch takes a vehicle away from someone who needs it.
 */
function ConfirmDialog({
  emergencyType,
  busy,
  onCancel,
  onConfirm,
}: {
  emergencyType: EmergencyType;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-ink-950/80 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ scale: 0.94, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.94, y: 12 }}
        className="card w-full max-w-md p-6"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emergency-500/15">
            <AlertTriangle className="h-5 w-5 text-emergency-400" aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-bold">Send an ambulance?</h2>
            <p className="mt-1 text-sm text-ink-400">
              This dispatches a real vehicle for{' '}
              <span className="font-semibold text-ink-200">
                {EMERGENCY_TYPE_LABELS[emergencyType].toLowerCase()}
              </span>
              . Only continue if this is a genuine emergency.
            </p>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onCancel} className="btn-secondary flex-1 py-3">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="btn-primary flex-1 py-3"
          >
            {busy ? <Spinner className="h-4 w-4" /> : <Siren className="h-4 w-4" aria-hidden />}
            Send now
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The live-tracking view, shown while a case is running. */
function LiveCase({ caseData, onCancel }: { caseData: EmergencyRequestDto; onCancel: () => void }) {
  const heading = caseData.status === 'TRANSPORTING' ? 'toHospital' : 'toScene';
  const crewIsWithPatient = ['ON_SCENE', 'TRANSPORTING', 'ARRIVED_AT_HOSPITAL'].includes(
    caseData.status,
  );

  /**
   * Whether a countdown means anything right now. It does while the vehicle is
   * travelling -- towards the patient, and again towards the hospital. It does
   * not while the crew is standing still with the patient.
   */
  const showEta = ['ASSIGNED', 'EN_ROUTE_TO_SCENE', 'TRANSPORTING'].includes(caseData.status);

  const fitPoints = useMemo(() => {
    const points = [caseData.pickup];
    if (caseData.ambulance?.location) points.push(caseData.ambulance.location);
    if (caseData.status === 'TRANSPORTING' && caseData.hospital) {
      points.push(caseData.hospital.location);
    }
    return points;
  }, [caseData.pickup, caseData.ambulance?.location, caseData.hospital, caseData.status]);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,400px)_1fr]">
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span className={`chip ${PRIORITY_STYLES[caseData.priority]}`}>
                {PRIORITY_LABELS[caseData.priority]}
              </span>
              <span className="numeric text-xs font-semibold text-ink-400">{caseData.code}</span>
            </div>
            <span className={`chip ${REQUEST_STATUS_STYLES[caseData.status]}`}>
              {REQUEST_STATUS_LABELS[caseData.status]}
            </span>
          </div>

          <div className="px-5 py-6 text-center">
            {caseData.status === 'SEARCHING' || caseData.status === 'PENDING' ? (
              <>
                <Spinner className="mx-auto h-8 w-8 text-emergency-400" />
                <p className="mt-3 text-base font-bold">Finding the nearest ambulance</p>
                <p className="mt-1 text-sm text-ink-400">
                  Offering your case to the closest suitable crew. Stay on this screen.
                </p>
              </>
            ) : caseData.status === 'NO_AMBULANCE_AVAILABLE' ? (
              <>
                <AlertTriangle className="mx-auto h-8 w-8 text-emergency-400" aria-hidden />
                <p className="mt-3 text-base font-bold text-emergency-300">
                  No ambulance available
                </p>
                <p className="mt-1 text-sm text-ink-400">
                  Please call your local emergency number immediately.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-ink-400">
                  {showEta
                    ? caseData.status === 'TRANSPORTING'
                      ? 'Reaching hospital in'
                      : 'Arriving in'
                    : 'Status'}
                </p>
                {/* The ETA gets the full display size -- during transport too,
                    which is the longest part of the journey and the stretch a
                    patient most wants a number for. A status sentence is far
                    longer and would wrap awkwardly at that scale. */}
                {showEta ? (
                  <p className="numeric mt-1 text-5xl font-extrabold leading-none text-emergency-300">
                    {formatEta(caseData.etaSeconds)}
                  </p>
                ) : (
                  <p className="mt-1.5 text-2xl font-bold leading-tight text-emergency-300">
                    {REQUEST_STATUS_LABELS[caseData.status]}
                  </p>
                )}
                {caseData.route && showEta && (
                  <p className="mt-2 text-sm text-ink-400">
                    {formatDistance(caseData.route.distanceMetres)}{' '}
                    {caseData.status === 'TRANSPORTING' ? 'to go' : 'away'}
                    {caseData.ambulance && caseData.ambulance.speedMps > 1 && (
                      <> · {Math.round(caseData.ambulance.speedMps * 3.6)} km/h</>
                    )}
                  </p>
                )}
              </>
            )}
          </div>

          {caseData.ambulance && (
            <div className="border-t border-ink-700 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15">
                  <AmbulanceIcon className="h-5 w-5 text-sky-300" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="numeric text-sm font-bold">{caseData.ambulance.vehicleNumber}</p>
                  <p className="text-xs text-ink-400">
                    {AMBULANCE_TYPE_LABELS[caseData.ambulance.type]}
                  </p>
                </div>
                {caseData.ambulance.driver && (
                  <a
                    href={`tel:${caseData.ambulance.driver.phone}`}
                    className="btn-secondary px-3 py-2"
                    aria-label={`Call ${caseData.ambulance.driver.name}`}
                  >
                    <Phone className="h-4 w-4" aria-hidden />
                  </a>
                )}
              </div>

              {caseData.ambulance.crew.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {caseData.ambulance.crew.map((member) => (
                    <span key={member.name} className="chip bg-ink-700 text-ink-200">
                      {member.name} · {member.role}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {caseData.hospital && (
            <div className="flex items-center gap-3 border-t border-ink-700 px-5 py-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/15">
                <Building2 className="h-5 w-5 text-teal-300" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{caseData.hospital.name}</p>
                <p className="truncate text-xs text-ink-400">{caseData.hospital.address}</p>
              </div>
            </div>
          )}

          <div className="border-t border-ink-700 px-5 py-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={crewIsWithPatient}
              className="btn-secondary w-full py-2.5 text-emergency-300 disabled:text-ink-500"
            >
              <X className="h-4 w-4" aria-hidden />
              {crewIsWithPatient ? 'Speak to the crew to cancel' : 'Cancel this request'}
            </button>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Progress</SectionTitle>
          <StatusTimeline status={caseData.status} events={caseData.timeline} />
        </Card>

        <Card className="p-5">
          <SectionTitle>Details sent to the crew</SectionTitle>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-400">Emergency</dt>
              <dd className="text-right font-medium">
                {EMERGENCY_TYPE_LABELS[caseData.emergencyType]}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-400">Blood group</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                <Droplet className="h-3.5 w-3.5 text-emergency-400" aria-hidden />
                {caseData.patient.bloodGroup}
              </dd>
            </div>
            {caseData.patient.medicalNotes && (
              <div>
                <dt className="text-ink-400">Medical notes</dt>
                <dd className="mt-0.5 text-ink-200">{caseData.patient.medicalNotes}</dd>
              </div>
            )}
            {caseData.notes && (
              <div>
                <dt className="text-ink-400">Your note</dt>
                <dd className="mt-0.5 text-ink-200">{caseData.notes}</dd>
              </div>
            )}
            {caseData.triageReasons.length > 0 && (
              <div>
                <dt className="text-ink-400">Triage</dt>
                <dd className="mt-0.5 text-ink-200">{caseData.triageReasons.join('. ')}.</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      <Card className="relative min-h-[460px] overflow-hidden p-0 lg:min-h-0">
        <MapView
          className="h-full min-h-[460px] w-full"
          centre={caseData.pickup}
          patient={caseData.pickup}
          ambulances={caseData.ambulance ? [caseData.ambulance] : []}
          hospitals={caseData.hospital ? [caseData.hospital] : []}
          destinationHospitalId={caseData.hospital?.id ?? null}
          route={caseData.route}
          routeStage={heading}
          fitTo={fitPoints}
          focusedAmbulanceId={caseData.ambulance?.id ?? null}
        />

        {caseData.ambulance?.location && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/90 px-4 py-2 text-sm shadow-xl backdrop-blur">
              <Navigation className="h-4 w-4 text-sky-300" aria-hidden />
              <span className="numeric font-semibold">{caseData.ambulance.vehicleNumber}</span>
              <span className="text-ink-400">
                {Math.round(caseData.ambulance.speedMps * 3.6)} km/h
              </span>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
