/**
 * The hospital desk.
 *
 * Answers one question: who is coming to us, and when. Plus the bed count,
 * which the dispatcher reads when choosing a destination -- so keeping it
 * current here directly affects where patients are sent.
 */

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { BedDouble, Building2, Clock, Droplet, Minus, Plus, Siren } from 'lucide-react';
import {
  EMERGENCY_TYPE_LABELS,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  type EmergencyRequestDto,
  type FleetStatsDto,
  type HospitalDto,
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { Card, EmptyState, ErrorNotice, SectionTitle, Skeleton, StatTile } from '../components/ui';
import { formatEta, formatRelative, PRIORITY_STYLES, REQUEST_STATUS_STYLES } from '../lib/format';

/** Cases whose patient is en route to, or has just reached, a hospital. */
const INBOUND_STATUSES = new Set(['TRANSPORTING', 'ARRIVED_AT_HOSPITAL']);

export function HospitalBoard() {
  const [cases, setCases] = useState<EmergencyRequestDto[]>([]);
  const [hospitals, setHospitals] = useState<HospitalDto[]>([]);
  const [stats, setStats] = useState<FleetStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [casesResponse, hospitalResponse, statsResponse] = await Promise.all([
        api.get<{ items: EmergencyRequestDto[] }>('/admin/requests/active'),
        api.get<{ items: HospitalDto[] }>('/hospitals'),
        api.get<FleetStatsDto>('/admin/stats'),
      ]);
      setCases(casesResponse.data.items);
      setHospitals(hospitalResponse.data.items);
      setStats(statsResponse.data);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 25_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useSocketEvent('request:updated', (updated) => {
    setCases((previous) => {
      const isOpen = !['COMPLETED', 'CANCELLED', 'NO_AMBULANCE_AVAILABLE'].includes(updated.status);
      const without = previous.filter((item) => item.id !== updated.id);
      return isOpen ? [updated, ...without] : without;
    });
  });

  useSocketEvent('request:created', (created) => {
    setCases((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
  });

  const adjustBeds = useCallback(
    async (hospital: HospitalDto, delta: number): Promise<void> => {
      const available = Math.max(0, Math.min(hospital.beds.total, hospital.beds.available + delta));
      if (available === hospital.beds.available) return;

      // Applied locally first so the control feels instant, then reconciled
      // with whatever the server actually stored.
      setHospitals((previous) =>
        previous.map((item) =>
          item.id === hospital.id ? { ...item, beds: { ...item.beds, available } } : item,
        ),
      );

      try {
        const response = await api.patch<{ hospital: HospitalDto }>(
          `/hospitals/${hospital.id}/beds`,
          { available },
        );
        setHospitals((previous) =>
          previous.map((item) => (item.id === hospital.id ? response.data.hospital : item)),
        );
      } catch (caught) {
        toast.error(errorMessage(caught));
        void refresh();
      }
    },
    [refresh],
  );

  const inbound = cases.filter((item) => INBOUND_STATUSES.has(item.status));
  const dispatched = cases.filter((item) => !INBOUND_STATUSES.has(item.status));

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6">
      {error && <ErrorNotice message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Inbound now"
          value={inbound.length}
          hint="Patients en route to a hospital"
          accent={inbound.length > 0 ? 'text-indigo-300' : 'text-ink-100'}
          icon={<Siren className="h-4 w-4" />}
        />
        <StatTile
          label="Cases in progress"
          value={dispatched.length}
          hint="Dispatched but not yet transporting"
          icon={<Clock className="h-4 w-4" />}
        />
        <StatTile
          label="Beds free"
          value={stats?.hospitalBeds.available ?? '--'}
          hint={`of ${stats?.hospitalBeds.total ?? '--'} in the network`}
          accent="text-emerald-300"
          icon={<BedDouble className="h-4 w-4" />}
        />
        <StatTile
          label="Completed today"
          value={stats?.completedToday ?? '--'}
          hint={`${stats?.requestsToday ?? 0} raised today`}
          icon={<Building2 className="h-4 w-4" />}
        />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Incoming patients</h1>
            <p className="text-sm text-ink-400">
              Arriving by ambulance. Details update as the crew reports in.
            </p>
          </div>
          <span className="numeric chip bg-indigo-500/15 text-indigo-300">{inbound.length}</span>
        </div>

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-20" />
            ))}
          </div>
        ) : inbound.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title="No inbound patients"
            description="Cases appear here the moment a crew begins transporting."
          />
        ) : (
          <div className="divide-y divide-ink-800">
            {inbound.map((item) => (
              <div key={item.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`chip ${PRIORITY_STYLES[item.priority]}`}>
                    {PRIORITY_LABELS[item.priority]}
                  </span>
                  <span className="numeric text-xs font-semibold text-ink-300">{item.code}</span>
                  <span className={`chip ${REQUEST_STATUS_STYLES[item.status]}`}>
                    {REQUEST_STATUS_LABELS[item.status]}
                  </span>
                  <span className="ml-auto text-sm font-semibold text-indigo-300">
                    ETA {formatEta(item.etaSeconds)}
                  </span>
                </div>

                <div className="mt-2.5 grid gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-ink-400">Patient</p>
                    <p className="text-sm font-semibold">{item.patient.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-ink-400">
                      <Droplet className="h-3 w-3 text-emergency-400" aria-hidden />
                      {item.patient.bloodGroup}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-400">Presenting</p>
                    <p className="text-sm">{EMERGENCY_TYPE_LABELS[item.emergencyType]}</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-400">Ambulance</p>
                    <p className="numeric text-sm">{item.ambulance?.vehicleNumber ?? '--'}</p>
                    <p className="text-xs text-ink-400">{item.hospital?.name}</p>
                  </div>
                </div>

                {item.patient.medicalNotes && (
                  <p className="mt-2.5 rounded-lg border border-amber-700/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-100">
                    <span className="font-bold uppercase tracking-wider text-amber-300">
                      Notes:{' '}
                    </span>
                    {item.patient.medicalNotes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle>Bed availability</SectionTitle>
        <p className="-mt-1 mb-4 text-sm text-ink-400">
          The dispatcher reads these numbers when choosing where to send a patient. Keep them
          current.
        </p>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {hospitals.map((hospital) => {
            const ratio =
              hospital.beds.total > 0 ? hospital.beds.available / hospital.beds.total : 0;
            return (
              <div key={hospital.id} className="rounded-xl border border-ink-700 bg-ink-900/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{hospital.name}</p>
                    <p className="truncate text-xs text-ink-400">{hospital.address}</p>
                  </div>
                  <span className="chip shrink-0 bg-ink-700 text-ink-200">
                    L{hospital.traumaLevel}
                  </span>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => adjustBeds(hospital, -1)}
                    disabled={hospital.beds.available === 0}
                    className="btn-secondary px-2.5 py-1.5"
                    aria-label={`Reduce free beds at ${hospital.name}`}
                  >
                    <Minus className="h-3.5 w-3.5" aria-hidden />
                  </button>

                  <div className="flex-1 text-center">
                    <p className="numeric text-2xl font-bold leading-none">
                      {hospital.beds.available}
                      <span className="text-sm font-medium text-ink-400">
                        {' '}
                        / {hospital.beds.total}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => adjustBeds(hospital, 1)}
                    disabled={hospital.beds.available >= hospital.beds.total}
                    className="btn-secondary px-2.5 py-1.5"
                    aria-label={`Increase free beds at ${hospital.name}`}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>

                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className={`h-full rounded-full transition-[width] ${
                      ratio < 0.1
                        ? 'bg-emergency-500'
                        : ratio < 0.25
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {dispatched.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-ink-700 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">
              Cases in progress
            </h2>
          </div>
          <div className="divide-y divide-ink-800">
            {dispatched.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-5 py-3">
                <span className={`chip ${PRIORITY_STYLES[item.priority]}`}>{item.priority}</span>
                <span className="numeric text-xs text-ink-300">{item.code}</span>
                <span className="truncate text-sm">
                  {EMERGENCY_TYPE_LABELS[item.emergencyType]}
                </span>
                <span className={`chip ml-auto ${REQUEST_STATUS_STYLES[item.status]}`}>
                  {REQUEST_STATUS_LABELS[item.status]}
                </span>
                <span className="w-20 text-right text-xs text-ink-400">
                  {formatRelative(item.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
