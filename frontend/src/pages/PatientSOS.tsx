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
  Crosshair,
  Droplet,
  Navigation,
  Phone,
  Siren,
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
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useGeolocation } from '../hooks/useGeolocation';
import { MapView } from '../components/MapView';
import { StatusTimeline } from '../components/StatusTimeline';
import { Card, ErrorNotice, FullPageLoader, SectionTitle, Spinner } from '../components/ui';
import { formatDistance, formatEta, PRIORITY_STYLES, REQUEST_STATUS_STYLES } from '../lib/format';

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

  /** Load whatever case is already running for this caller. */
  useEffect(() => {
    api
      .get<{ request: EmergencyRequestDto | null }>('/emergency/active')
      .then((response) => setActiveCase(response.data.request))
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  }, []);

  /** Show what is around the caller while they are deciding. */
  useEffect(() => {
    if (!geo.position || activeCase) return;
    const params = { lat: geo.position.lat, lng: geo.position.lng, radiusKm: 12 };

    void api
      .get<{ items: AmbulanceDto[] }>('/ambulances/nearby', { params })
      .then((response) => setNearby(response.data.items))
      .catch(() => setNearby([]));

    void api
      .get<{ items: HospitalDto[] }>('/hospitals/nearby', { params: { ...params, limit: 8 } })
      .then((response) => setHospitals(response.data.items))
      .catch(() => setHospitals([]));
  }, [geo.position, activeCase]);

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
      return LIVE_STATUSES.has(updated.status) ? updated : null;
    });
  });

  useSocketEvent('request:created', (created) => {
    setActiveCase(created);
  });

  useSocketEvent('request:status', (event) => {
    setActiveCase((previous) => {
      if (!previous || previous.id !== event.requestId) return previous;
      if (!LIVE_STATUSES.has(event.status)) {
        if (event.status === 'COMPLETED') toast.success('Case closed. Take care.');
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
    if (!geo.position) {
      setError('We need your location before an ambulance can be sent.');
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const response = await api.post<{ request: EmergencyRequestDto }>('/emergency', {
        emergencyType,
        pickup: geo.position,
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
  }, [geo.position, emergencyType, notes, vitals]);

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

  return activeCase ? (
    <LiveCase caseData={activeCase} onCancel={cancelCase} />
  ) : (
    <div className="mx-auto grid w-full max-w-[1600px] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-700 bg-gradient-to-br from-emergency-950/40 to-transparent px-6 py-5">
            <h1 className="text-xl font-bold tracking-tight">Hello, {user?.name.split(' ')[0]}</h1>
            <p className="mt-0.5 text-sm text-ink-400">
              Press the button and stay on this screen. Help is dispatched automatically.
            </p>
          </div>

          <div className="flex flex-col items-center px-6 py-8">
            <SosButton
              disabled={!geo.position || submitting}
              busy={submitting}
              onPress={() => setConfirming(true)}
            />

            <div className="mt-6 w-full space-y-2">
              {geo.error && <ErrorNotice message={geo.error} />}
              {error && <ErrorNotice message={error} />}

              <div className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-900/60 px-3.5 py-2.5">
                <span className="flex items-center gap-2 text-sm text-ink-300">
                  <Crosshair
                    className={`h-4 w-4 ${geo.position ? 'text-emerald-400' : 'text-amber-400'}`}
                    aria-hidden
                  />
                  {geo.loading
                    ? 'Finding your location'
                    : geo.position
                      ? `Located to ${Math.round(geo.accuracy ?? 0)} m`
                      : 'Location unavailable'}
                </span>
                <button type="button" onClick={geo.refresh} className="btn-ghost px-2 py-1 text-xs">
                  Refresh
                </button>
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
          centre={geo.position ?? undefined}
          patient={geo.position}
          ambulances={nearby}
          hospitals={hospitals}
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
                  {crewIsWithPatient ? 'Status' : 'Arriving in'}
                </p>
                {/* The ETA gets the full display size; a status sentence is far
                    longer and would wrap awkwardly at that scale. */}
                {crewIsWithPatient ? (
                  <p className="mt-1.5 text-2xl font-bold leading-tight text-emergency-300">
                    {REQUEST_STATUS_LABELS[caseData.status]}
                  </p>
                ) : (
                  <p className="numeric mt-1 text-5xl font-extrabold leading-none text-emergency-300">
                    {formatEta(caseData.etaSeconds)}
                  </p>
                )}
                {caseData.route && !crewIsWithPatient && (
                  <p className="mt-2 text-sm text-ink-400">
                    {formatDistance(caseData.route.distanceMetres)} away
                    {caseData.route.source === 'straight-line' && ' (estimated)'}
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
