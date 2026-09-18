/**
 * The crew screen.
 *
 * Designed to be read at a glance from a mounted device: large targets, one
 * decision on screen at a time, and the next action always the biggest thing
 * visible. A crew should never have to hunt for the button.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Activity,
  Ambulance as AmbulanceIcon,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Droplet,
  MapPin,
  Phone,
  Power,
  Siren,
  X,
} from 'lucide-react';
import {
  AMBULANCE_TYPE_LABELS,
  EMERGENCY_TYPE_LABELS,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  type AmbulanceDto,
  type DispatchOfferDto,
  type EmergencyRequestDto,
  type RequestStatus,
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useGeolocation } from '../hooks/useGeolocation';
import { MapView } from '../components/MapView';
import { StatusTimeline } from '../components/StatusTimeline';
import {
  Card,
  EmptyState,
  ErrorNotice,
  FullPageLoader,
  SectionTitle,
  Spinner,
} from '../components/ui';
import { AMBULANCE_STATUS_STYLES, formatDistance, formatEta, PRIORITY_STYLES } from '../lib/format';

/** The crew's next action at each stage, in order. */
const NEXT_STEP: Partial<Record<RequestStatus, { status: RequestStatus; label: string }>> = {
  ASSIGNED: { status: 'EN_ROUTE_TO_SCENE', label: 'Start driving to the scene' },
  EN_ROUTE_TO_SCENE: { status: 'ON_SCENE', label: 'Arrived at the patient' },
  ON_SCENE: { status: 'TRANSPORTING', label: 'Leaving for hospital' },
  TRANSPORTING: { status: 'ARRIVED_AT_HOSPITAL', label: 'Arrived at hospital' },
  ARRIVED_AT_HOSPITAL: { status: 'COMPLETED', label: 'Close this case' },
};

export function DriverShift() {
  const { socket } = useAuth();
  // Crews stream position continuously; this is the source of those pings.
  const geo = useGeolocation({ watch: true });

  const [vehicle, setVehicle] = useState<AmbulanceDto | null>(null);
  const [activeCase, setActiveCase] = useState<EmergencyRequestDto | null>(null);
  const [offer, setOffer] = useState<DispatchOfferDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadShift = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<{
        ambulance: AmbulanceDto;
        activeRequest: EmergencyRequestDto | null;
      }>('/driver/shift');
      setVehicle(response.data.ambulance);
      setActiveCase(response.data.activeRequest);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadShift();
  }, [loadShift]);

  /**
   * Stream the device's position to the server over the socket.
   *
   * Only while on duty: a crew that has signed off should not be broadcasting
   * their location, and an offline vehicle is not dispatchable anyway.
   */
  useEffect(() => {
    if (!socket || !geo.position || !vehicle || vehicle.status === 'OFFLINE') return;
    socket.emit('driver:location', {
      lat: geo.position.lat,
      lng: geo.position.lng,
      ...(geo.accuracy === null ? {} : { accuracy: geo.accuracy }),
    });
  }, [socket, geo.position, geo.accuracy, vehicle]);

  useSocketEvent('dispatch:offer', (incoming) => {
    setOffer(incoming);
    // A crew may not be looking at the screen; make the arrival audible.
    void playAlert();
  });

  useSocketEvent('dispatch:offer_revoked', ({ requestId, reason }) => {
    setOffer((previous) => (previous?.requestId === requestId ? null : previous));
    toast(reason, { icon: 'ℹ️' });
  });

  useSocketEvent('request:updated', (updated) => {
    setActiveCase((previous) => (previous?.id === updated.id ? updated : previous));
  });

  const respond = useCallback(
    async (accept: boolean): Promise<void> => {
      if (!offer) return;
      setBusy(true);
      try {
        const response = await api.post<{ request: EmergencyRequestDto | null }>('/driver/offer', {
          requestId: offer.requestId,
          accept,
        });
        setOffer(null);
        if (accept && response.data.request) {
          setActiveCase(response.data.request);
          toast.success(`Case ${offer.code} accepted`);
        }
        await loadShift();
      } catch (caught) {
        toast.error(errorMessage(caught));
        setOffer(null);
      } finally {
        setBusy(false);
      }
    },
    [offer, loadShift],
  );

  const advance = useCallback(
    async (status: RequestStatus): Promise<void> => {
      if (!activeCase) return;
      setBusy(true);
      try {
        const body: Record<string, unknown> = { requestId: activeCase.id, status };
        // The destination is confirmed at the moment transport begins.
        if (status === 'TRANSPORTING' && activeCase.hospital) {
          body.destinationHospitalId = activeCase.hospital.id;
        }
        const response = await api.post<{ request: EmergencyRequestDto }>('/driver/status', body);

        if (status === 'COMPLETED') {
          setActiveCase(null);
          toast.success('Case closed. Back in service.');
          await loadShift();
        } else {
          setActiveCase(response.data.request);
        }
      } catch (caught) {
        toast.error(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [activeCase, loadShift],
  );

  const setDuty = useCallback(async (status: 'AVAILABLE' | 'OFFLINE'): Promise<void> => {
    setBusy(true);
    try {
      const response = await api.post<{ ambulance: AmbulanceDto }>('/driver/duty', { status });
      setVehicle(response.data.ambulance);
      toast.success(status === 'AVAILABLE' ? 'You are on duty' : 'You are off duty');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const mapPoints = useMemo(() => {
    const points = [];
    // The device's own fix when there is one; otherwise the vehicle's last
    // known position, so a crew without location permission still sees their
    // own ambulance rather than an empty map of the city.
    if (geo.position) points.push(geo.position);
    else if (vehicle?.location) points.push(vehicle.location);
    if (activeCase) points.push(activeCase.pickup);
    if (activeCase?.status === 'TRANSPORTING' && activeCase.hospital) {
      points.push(activeCase.hospital.location);
    }
    return points;
  }, [geo.position, activeCase, vehicle]);

  if (loading) return <FullPageLoader label="Loading your shift" />;

  if (error && !vehicle) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Card className="p-6">
          <ErrorNotice message={error} />
          <p className="mt-4 text-sm text-ink-400">
            A control-room administrator assigns a vehicle to each crew account. Ask them to add you
            to an ambulance.
          </p>
        </Card>
      </div>
    );
  }

  const onDuty = vehicle ? vehicle.status !== 'OFFLINE' : false;
  const nextStep = activeCase ? NEXT_STEP[activeCase.status] : undefined;

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,400px)_1fr]">
      <div className="space-y-5">
        {vehicle && (
          <Card className="overflow-hidden">
            <div className="flex items-center gap-3 border-b border-ink-700 px-5 py-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-700">
                <AmbulanceIcon className="h-5 w-5 text-ink-200" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="numeric text-base font-bold">{vehicle.vehicleNumber}</p>
                <p className="text-xs text-ink-400">{AMBULANCE_TYPE_LABELS[vehicle.type]}</p>
              </div>
              <span className={`chip ${AMBULANCE_STATUS_STYLES[vehicle.status]}`}>
                {vehicle.status.replace(/_/g, ' ')}
              </span>
            </div>

            <div className="px-5 py-4">
              <button
                type="button"
                onClick={() => setDuty(onDuty ? 'OFFLINE' : 'AVAILABLE')}
                disabled={busy || Boolean(activeCase)}
                className={`w-full py-3 ${onDuty ? 'btn-secondary' : 'btn-primary'}`}
              >
                <Power className="h-4 w-4" aria-hidden />
                {onDuty ? 'Go off duty' : 'Go on duty'}
              </button>
              {activeCase && (
                <p className="mt-2 text-center text-xs text-ink-500">
                  Close your current case before signing off.
                </p>
              )}

              <div className="mt-4 flex items-center justify-between rounded-xl border border-ink-700 bg-ink-900/60 px-3.5 py-2.5 text-sm">
                <span className="flex items-center gap-2 text-ink-300">
                  <MapPin
                    className={`h-4 w-4 ${geo.position ? 'text-emerald-400' : 'text-amber-400'}`}
                    aria-hidden
                  />
                  GPS
                </span>
                <span className="text-ink-400">
                  {geo.position ? `±${Math.round(geo.accuracy ?? 0)} m` : 'Searching'}
                </span>
              </div>
              {geo.error && <p className="mt-2 text-xs text-amber-300">{geo.error}</p>}
            </div>
          </Card>
        )}

        {activeCase ? (
          <>
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
                <span className={`chip ${PRIORITY_STYLES[activeCase.priority]}`}>
                  {PRIORITY_LABELS[activeCase.priority]}
                </span>
                <span className="numeric text-xs font-semibold text-ink-400">
                  {activeCase.code}
                </span>
              </div>

              <div className="px-5 py-4">
                <p className="text-xs font-bold uppercase tracking-wider text-ink-400">
                  {REQUEST_STATUS_LABELS[activeCase.status]}
                </p>
                <p className="mt-1 text-lg font-bold">
                  {EMERGENCY_TYPE_LABELS[activeCase.emergencyType]}
                </p>

                <div className="mt-4 space-y-2.5 text-sm">
                  <div className="flex items-start gap-2.5">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden />
                    <span>
                      {activeCase.pickupAddress ??
                        `${activeCase.pickup.lat.toFixed(5)}, ${activeCase.pickup.lng.toFixed(5)}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <Clock className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
                    <span>ETA {formatEta(activeCase.etaSeconds)}</span>
                    {activeCase.route && (
                      <span className="text-ink-400">
                        · {formatDistance(activeCase.route.distanceMetres)}
                      </span>
                    )}
                  </div>
                </div>

                {nextStep && (
                  <button
                    type="button"
                    onClick={() => advance(nextStep.status)}
                    disabled={busy}
                    className="btn-primary mt-5 w-full py-4 text-base"
                  >
                    {busy ? (
                      <Spinner className="h-5 w-5" />
                    ) : (
                      <ArrowRight className="h-5 w-5" aria-hidden />
                    )}
                    {nextStep.label}
                  </button>
                )}
              </div>

              <div className="border-t border-ink-700 px-5 py-4">
                <p className="label">Patient</p>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{activeCase.patient.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-ink-400">
                      <Droplet className="h-3 w-3 text-emergency-400" aria-hidden />
                      {activeCase.patient.bloodGroup}
                    </p>
                  </div>
                  <a
                    href={`tel:${activeCase.patient.phone}`}
                    className="btn-secondary px-3 py-2"
                    aria-label={`Call ${activeCase.patient.name}`}
                  >
                    <Phone className="h-4 w-4" aria-hidden />
                  </a>
                </div>

                {activeCase.patient.medicalNotes && (
                  <div className="mt-3 rounded-xl border border-amber-700/40 bg-amber-950/25 px-3 py-2.5">
                    <p className="text-xs font-bold uppercase tracking-wider text-amber-300">
                      Medical notes
                    </p>
                    <p className="mt-0.5 text-sm text-amber-100">
                      {activeCase.patient.medicalNotes}
                    </p>
                  </div>
                )}

                {activeCase.notes && (
                  <p className="mt-3 rounded-xl bg-ink-800 px-3 py-2.5 text-sm text-ink-200">
                    “{activeCase.notes}”
                  </p>
                )}
              </div>

              {activeCase.hospital && (
                <div className="flex items-center gap-3 border-t border-ink-700 px-5 py-4">
                  <Building2 className="h-4 w-4 shrink-0 text-teal-300" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{activeCase.hospital.name}</p>
                    <p className="truncate text-xs text-ink-400">
                      {activeCase.hospital.beds.available} beds free
                    </p>
                  </div>
                </div>
              )}
            </Card>

            <Card className="p-5">
              <SectionTitle>Case progress</SectionTitle>
              <StatusTimeline status={activeCase.status} events={activeCase.timeline} />
            </Card>
          </>
        ) : (
          <Card>
            <EmptyState
              icon={<Activity className="h-8 w-8" />}
              title={onDuty ? 'Standing by' : 'You are off duty'}
              description={
                onDuty
                  ? 'You will be alerted the moment a case is offered to your vehicle.'
                  : 'Go on duty to start receiving dispatch offers.'
              }
            />
          </Card>
        )}
      </div>

      <Card className="min-h-[420px] overflow-hidden p-0 lg:min-h-0">
        <MapView
          className="h-full min-h-[420px] w-full"
          centre={geo.position ?? vehicle?.location ?? activeCase?.pickup ?? undefined}
          patient={activeCase?.pickup ?? null}
          ambulances={
            vehicle && geo.position
              ? [{ ...vehicle, location: geo.position }]
              : vehicle
                ? [vehicle]
                : []
          }
          hospitals={activeCase?.hospital ? [activeCase.hospital] : []}
          destinationHospitalId={activeCase?.hospital?.id ?? null}
          route={activeCase?.route ?? null}
          routeStage={activeCase?.status === 'TRANSPORTING' ? 'toHospital' : 'toScene'}
          fitTo={mapPoints}
          focusedAmbulanceId={vehicle?.id ?? null}
        />
      </Card>

      <AnimatePresence>
        {offer && <OfferModal offer={offer} busy={busy} onRespond={respond} />}
      </AnimatePresence>
    </div>
  );
}

/**
 * The dispatch offer.
 *
 * Deliberately blocking and full-screen with a visible countdown: an offer that
 * expires unnoticed costs the patient minutes, so it takes over the display
 * until the crew answers it one way or the other.
 */
function OfferModal({
  offer,
  busy,
  onRespond,
}: {
  offer: DispatchOfferDto;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecondsLeft(
        Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - Date.now()) / 1000)),
      );
    }, 250);
    return () => window.clearInterval(tick);
  }, [offer.expiresAt]);

  const total = 25;
  const fraction = Math.min(1, secondsLeft / total);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-ink-950/90 p-5 backdrop-blur-md"
      role="alertdialog"
      aria-modal="true"
      aria-label="Incoming dispatch offer"
    >
      <motion.div
        initial={{ scale: 0.92, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 16 }}
        className="card w-full max-w-md overflow-hidden"
      >
        <div className="relative bg-gradient-to-br from-emergency-700 to-emergency-900 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/15">
              <Siren className="h-6 w-6 text-white" aria-hidden />
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-emergency-100">
                Dispatch offer
              </p>
              <p className="numeric text-lg font-extrabold text-white">{offer.code}</p>
            </div>
            <span className="numeric ml-auto text-3xl font-extrabold text-white">
              {secondsLeft}s
            </span>
          </div>

          {/* The bar drains as the window closes, readable from a distance. */}
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-200 ease-linear"
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
        </div>

        <div className="px-6 py-5">
          <div className="flex items-center gap-2">
            <span className={`chip ${PRIORITY_STYLES[offer.priority]}`}>
              {PRIORITY_LABELS[offer.priority]}
            </span>
            <span className="text-sm font-semibold">
              {EMERGENCY_TYPE_LABELS[offer.emergencyType]}
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-ink-800 px-3.5 py-3">
              <dt className="text-xs text-ink-400">Distance</dt>
              <dd className="numeric mt-0.5 text-lg font-bold">
                {formatDistance(offer.distanceMetres)}
              </dd>
            </div>
            <div className="rounded-xl bg-ink-800 px-3.5 py-3">
              <dt className="text-xs text-ink-400">Drive time</dt>
              <dd className="numeric mt-0.5 text-lg font-bold">{formatEta(offer.etaSeconds)}</dd>
            </div>
          </dl>

          <div className="mt-4 space-y-2 text-sm">
            <p className="font-semibold">{offer.patientName}</p>
            {offer.pickupAddress && (
              <p className="flex items-start gap-2 text-ink-300">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {offer.pickupAddress}
              </p>
            )}
            {offer.notes && (
              <p className="rounded-lg bg-ink-800 px-3 py-2 text-ink-200">“{offer.notes}”</p>
            )}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => onRespond(false)}
              disabled={busy}
              className="btn-secondary flex-1 py-3.5"
            >
              <X className="h-4 w-4" aria-hidden /> Decline
            </button>
            <button
              type="button"
              onClick={() => onRespond(true)}
              disabled={busy}
              className="btn-primary flex-[2] py-3.5 text-base"
            >
              {busy ? (
                <Spinner className="h-5 w-5" />
              ) : (
                <CheckCircle2 className="h-5 w-5" aria-hidden />
              )}
              Accept
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * A short alert tone for an incoming offer, synthesised rather than shipped as
 * an audio file. Browsers block audio until the user has interacted with the
 * page, so any failure here is ignored -- the visual alert is the real one.
 */
async function playAlert(): Promise<void> {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;

    const context = new AudioCtor();
    const now = context.currentTime;

    // Two rising notes: attention-getting without being alarming.
    for (const [index, frequency] of [880, 1170].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      const start = now + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    }

    window.setTimeout(() => void context.close(), 900);
  } catch {
    /* Audio is a nicety; the modal is the alert that matters. */
  }
}
