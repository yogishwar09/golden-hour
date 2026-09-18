/**
 * The control room.
 *
 * One screen answering the questions a duty manager actually asks: what is
 * happening right now, where is everything, and are we hitting our response
 * targets. Live throughout -- the fleet moves on the map as the vehicles move.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ambulance as AmbulanceIcon,
  BedDouble,
  CheckCircle2,
  Clock,
  Radio,
  TrendingUp,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AMBULANCE_STATUSES,
  EMERGENCY_TYPE_LABELS,
  PRIORITIES,
  PRIORITY_SLA_MINUTES,
  REQUEST_STATUS_LABELS,
  type AmbulanceDto,
  type EmergencyRequestDto,
  type FleetStatsDto,
  type HospitalDto,
  type TimeSeriesPointDto,
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { MapView } from '../components/MapView';
import { Card, EmptyState, ErrorNotice, SectionTitle, Skeleton, StatTile } from '../components/ui';
import {
  AMBULANCE_STATUS_COLOURS,
  AMBULANCE_STATUS_STYLES,
  formatDurationShort,
  formatEta,
  formatRelative,
  PRIORITY_STYLES,
  REQUEST_STATUS_STYLES,
} from '../lib/format';

/** How often the aggregate figures are refreshed. Live events cover the rest. */
const STATS_REFRESH_MS = 20_000;

export function ControlRoom() {
  const { socket } = useAuth();

  const [stats, setStats] = useState<FleetStatsDto | null>(null);
  const [series, setSeries] = useState<TimeSeriesPointDto[]>([]);
  const [fleet, setFleet] = useState<AmbulanceDto[]>([]);
  const [cases, setCases] = useState<EmergencyRequestDto[]>([]);
  const [hospitals, setHospitals] = useState<HospitalDto[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [statsResponse, seriesResponse, casesResponse] = await Promise.all([
        api.get<FleetStatsDto>('/admin/stats'),
        api.get<{ items: TimeSeriesPointDto[] }>('/admin/timeseries'),
        api.get<{ items: EmergencyRequestDto[] }>('/admin/requests/active'),
      ]);
      setStats(statsResponse.data);
      setSeries(seriesResponse.data.items);
      setCases(casesResponse.data.items);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api
      .get<{ items: HospitalDto[] }>('/hospitals')
      .then((response) => setHospitals(response.data.items))
      .catch(() => setHospitals([]));

    const timer = window.setInterval(() => void refresh(), STATS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Ask for the current fleet picture as soon as the socket is ready, then keep
  // it current from position events rather than re-fetching.
  useEffect(() => {
    if (!socket) return;
    const request = (): void => {
      socket.emit('fleet:subscribe');
    };
    request();
    socket.on('connect', request);
    return () => {
      socket.off('connect', request);
    };
  }, [socket]);

  useSocketEvent('fleet:snapshot', (vehicles) => setFleet(vehicles));

  useSocketEvent('ambulance:position', (event) => {
    setFleet((previous) =>
      previous.map((vehicle) =>
        vehicle.id === event.ambulanceId
          ? {
              ...vehicle,
              location: event.location,
              heading: event.heading,
              speedMps: event.speedMps,
              status: event.status,
              lastSeenAt: event.at,
            }
          : vehicle,
      ),
    );
  });

  useSocketEvent('ambulance:status', (event) => {
    setFleet((previous) =>
      previous.map((vehicle) =>
        vehicle.id === event.ambulanceId ? { ...vehicle, status: event.status } : vehicle,
      ),
    );
  });

  useSocketEvent('request:created', (created) => {
    setCases((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
  });

  useSocketEvent('request:updated', (updated) => {
    setCases((previous) => {
      const isOpen = !['COMPLETED', 'CANCELLED', 'NO_AMBULANCE_AVAILABLE'].includes(updated.status);
      const without = previous.filter((item) => item.id !== updated.id);
      return isOpen ? [updated, ...without] : without;
    });
  });

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  );

  const fleetChartData = useMemo(
    () =>
      AMBULANCE_STATUSES.map((status) => ({
        status: status.replace(/_/g, ' ').toLowerCase(),
        count: stats?.fleet[status] ?? 0,
        fill: AMBULANCE_STATUS_COLOURS[status],
      })).filter((row) => row.count > 0),
    [stats],
  );

  const seriesData = useMemo(
    () =>
      series.map((point) => ({
        label: point.bucket.slice(11, 16),
        requests: point.requests,
        completed: point.completed,
      })),
    [series],
  );

  const totalBeds = stats?.hospitalBeds.total ?? 0;
  const freeBeds = stats?.hospitalBeds.available ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6">
      {error && <ErrorNotice message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {stats ? (
          <>
            <StatTile
              label="Open cases"
              value={stats.activeRequests}
              hint={`${stats.requestsToday} raised today`}
              accent={stats.activeRequests > 0 ? 'text-emergency-300' : 'text-ink-100'}
              icon={<Radio className="h-4 w-4" />}
            />
            <StatTile
              label="Available now"
              value={stats.fleet.AVAILABLE}
              hint={`${Object.values(stats.fleet).reduce((a, b) => a + b, 0)} vehicles in fleet`}
              accent="text-emerald-300"
              icon={<AmbulanceIcon className="h-4 w-4" />}
            />
            <StatTile
              label="Mean response"
              value={formatDurationShort(stats.averageResponseSeconds)}
              hint="SOS to crew on scene, today"
              icon={<Clock className="h-4 w-4" />}
            />
            <StatTile
              label="Within target"
              value={
                stats.slaComplianceRate === null
                  ? '--'
                  : `${Math.round(stats.slaComplianceRate * 100)}%`
              }
              hint="Cases meeting their priority target"
              accent={
                stats.slaComplianceRate !== null && stats.slaComplianceRate < 0.8
                  ? 'text-amber-300'
                  : 'text-emerald-300'
              }
              icon={<TrendingUp className="h-4 w-4" />}
            />
            <StatTile
              label="Beds free"
              value={freeBeds}
              hint={`of ${totalBeds} across ${hospitals.length} hospitals`}
              accent={freeBeds / Math.max(1, totalBeds) < 0.1 ? 'text-amber-300' : 'text-ink-100'}
              icon={<BedDouble className="h-4 w-4" />}
            />
          </>
        ) : (
          Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[104px]" />)
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_minmax(0,420px)]">
        <Card className="relative min-h-[520px] overflow-hidden p-0">
          <div className="absolute left-4 top-4 z-[1000] rounded-xl border border-ink-700 bg-ink-900/90 px-3.5 py-2 backdrop-blur">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-300">Live fleet</p>
            <p className="numeric text-sm font-semibold">
              {fleet.filter((vehicle) => vehicle.status !== 'OFFLINE').length} on duty ·{' '}
              {cases.length} open
            </p>
          </div>

          <MapView
            className="h-full min-h-[520px] w-full"
            ambulances={fleet}
            hospitals={hospitals}
            patient={selectedCase?.pickup ?? null}
            route={selectedCase?.route ?? null}
            routeStage={selectedCase?.status === 'TRANSPORTING' ? 'toHospital' : 'toScene'}
            destinationHospitalId={selectedCase?.hospital?.id ?? null}
            focusedAmbulanceId={selectedCase?.ambulance?.id ?? null}
            fitTo={
              selectedCase
                ? [
                    selectedCase.pickup,
                    ...(selectedCase.ambulance?.location ? [selectedCase.ambulance.location] : []),
                  ]
                : fleet.flatMap((vehicle) => (vehicle.location ? [vehicle.location] : []))
            }
          />
        </Card>

        <Card className="flex max-h-[520px] flex-col overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">Open cases</h2>
            <span className="numeric chip bg-ink-700 text-ink-200">{cases.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {cases.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="h-8 w-8" />}
                title="Nothing open"
                description="Every case has been closed. New emergencies appear here immediately."
              />
            ) : (
              cases.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setSelectedCaseId((current) => (current === item.id ? null : item.id))
                  }
                  className={`w-full border-b border-ink-800 px-5 py-3.5 text-left transition-colors last:border-0 ${
                    selectedCaseId === item.id ? 'bg-ink-800' : 'hover:bg-ink-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`chip ${PRIORITY_STYLES[item.priority]}`}>
                      {item.priority}
                    </span>
                    <span className="numeric text-xs font-semibold text-ink-300">{item.code}</span>
                    <span className={`chip ml-auto ${REQUEST_STATUS_STYLES[item.status]}`}>
                      {REQUEST_STATUS_LABELS[item.status]}
                    </span>
                  </div>

                  <p className="mt-1.5 truncate text-sm font-semibold">
                    {EMERGENCY_TYPE_LABELS[item.emergencyType]}
                  </p>
                  <div className="mt-1 flex items-center gap-3 text-xs text-ink-400">
                    <span>{item.patient.name}</span>
                    {item.ambulance && (
                      <span className="numeric">{item.ambulance.vehicleNumber}</span>
                    )}
                    {item.etaSeconds !== null && <span>ETA {formatEta(item.etaSeconds)}</span>}
                    <span className="ml-auto">{formatRelative(item.createdAt)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Case volume, last 24 hours</SectionTitle>
          <div className="h-56">
            {seriesData.length === 0 ? (
              <EmptyState title="No cases in the last 24 hours" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={seriesData} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
                  <defs>
                    <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="completedFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2331" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="#5b6478"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#5b6478"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#11141c',
                      border: '1px solid #2a3040',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: '#b9c0d0' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    stroke="#f43f5e"
                    strokeWidth={2}
                    fill="url(#requestsFill)"
                    name="Raised"
                  />
                  <Area
                    type="monotone"
                    dataKey="completed"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#completedFill)"
                    name="Completed"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Fleet status</SectionTitle>
          <div className="h-56">
            {fleetChartData.length === 0 ? (
              <EmptyState title="No vehicles registered" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={fleetChartData}
                  layout="vertical"
                  margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2331" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="#5b6478"
                    fontSize={11}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="status"
                    stroke="#8a92a6"
                    fontSize={11}
                    width={96}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: '#1e2331' }}
                    contentStyle={{
                      background: '#11141c',
                      border: '1px solid #2a3040',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} name="Vehicles" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <SectionTitle>Response targets today</SectionTitle>
        {stats ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRIORITIES.map((priority) => (
              <div key={priority} className="rounded-xl border border-ink-700 bg-ink-900/50 p-4">
                <div className="flex items-center justify-between">
                  <span className={`chip ${PRIORITY_STYLES[priority]}`}>{priority}</span>
                  <span className="numeric text-xl font-bold">{stats.byPriority[priority]}</span>
                </div>
                <p className="mt-2 text-xs text-ink-400">
                  Target: on scene within {PRIORITY_SLA_MINUTES[priority]} min
                </p>
              </div>
            ))}
          </div>
        ) : (
          <Skeleton className="h-24" />
        )}
      </Card>

      {stats && stats.fleet.AVAILABLE === 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-700/50 bg-amber-950/30 px-5 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
          <div>
            <p className="text-sm font-bold text-amber-200">No vehicles available</p>
            <p className="text-sm text-amber-100/80">
              Every on-duty ambulance is committed. New emergencies will wait for a crew to free up.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Fleet roster: every vehicle, its crew and its current state. */
export function FleetRoster() {
  const [fleet, setFleet] = useState<AmbulanceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: AmbulanceDto[] }>('/ambulances')
      .then((response) => setFleet(response.data.items))
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  useSocketEvent('ambulance:status', (event) => {
    setFleet((previous) =>
      previous
        ? previous.map((vehicle) =>
            vehicle.id === event.ambulanceId ? { ...vehicle, status: event.status } : vehicle,
          )
        : previous,
    );
  });

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 sm:p-6">
      {error && <ErrorNotice message={error} />}

      <Card className="overflow-hidden p-0">
        <div className="border-b border-ink-700 px-5 py-4">
          <h1 className="text-lg font-bold tracking-tight">Fleet</h1>
          <p className="text-sm text-ink-400">Every registered vehicle and its current state.</p>
        </div>

        {!fleet ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-14" />
            ))}
          </div>
        ) : fleet.length === 0 ? (
          <EmptyState
            icon={<AmbulanceIcon className="h-8 w-8" />}
            title="No vehicles yet"
            description="Seed the database or add an ambulance to get started."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-700 text-left text-xs uppercase tracking-wider text-ink-400">
                <tr>
                  <th className="px-5 py-3 font-semibold">Vehicle</th>
                  <th className="px-5 py-3 font-semibold">Type</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Crew</th>
                  <th className="px-5 py-3 font-semibold">Base</th>
                  <th className="px-5 py-3 font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {fleet.map((vehicle) => (
                  <tr
                    key={vehicle.id}
                    className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40"
                  >
                    <td className="numeric px-5 py-3 font-semibold">{vehicle.vehicleNumber}</td>
                    <td className="px-5 py-3 text-ink-300">{vehicle.type}</td>
                    <td className="px-5 py-3">
                      <span className={`chip ${AMBULANCE_STATUS_STYLES[vehicle.status]}`}>
                        {vehicle.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-300">
                      {vehicle.driver?.name ?? '--'}
                      {vehicle.crew.length > 1 && (
                        <span className="text-ink-500"> +{vehicle.crew.length - 1}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-300">{vehicle.hospital?.name ?? '--'}</td>
                    <td className="px-5 py-3 text-ink-400">{formatRelative(vehicle.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle>What the colours mean</SectionTitle>
        <div className="flex flex-wrap gap-3">
          {AMBULANCE_STATUSES.map((status) => (
            <span key={status} className="flex items-center gap-2 text-xs text-ink-300">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: AMBULANCE_STATUS_COLOURS[status] }}
              />
              {status.replace(/_/g, ' ').toLowerCase()}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
