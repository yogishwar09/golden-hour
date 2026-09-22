/**
 * Fleet simulator.
 *
 * Logs in as every seeded driver, connects over the socket exactly as a crew
 * device would, and drives the vehicles: idle wandering near base, accepting
 * dispatch offers, following the real road route to the patient, and working
 * the case through to completion.
 *
 * This is how the system is demonstrated and load-checked without ten phones in
 * ten cars. It is an ordinary API client -- it is given no special access and
 * uses only the documented endpoints, so whatever works here works for a real
 * device.
 *
 *   npm run simulate -- --speed 6      run at six times real time
 *   npm run simulate -- --api http://localhost:4000
 */

import { io as connectSocket, type Socket } from 'socket.io-client';
import {
  haversineMetres,
  interpolate,
  type DispatchOfferDto,
  type EmergencyRequestDto,
  type LatLng,
} from '@sas/shared';
import { env } from '../config/env.js';

interface Options {
  apiUrl: string;
  speed: number;
  drivers: string[];
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const count = Number(read('--drivers') ?? 10);
  return {
    apiUrl: read('--api') ?? `http://localhost:${env.PORT}`,
    // Real time by default: an ambulance that crosses the city in ten seconds
    // does not look like an ambulance. `--speed` compresses it when someone is
    // watching a demo rather than the system.
    speed: Math.max(1, Math.min(20, Number(read('--speed') ?? 1))),
    drivers: Array.from({ length: count }, (_, index) =>
      index === 0 ? 'driver@demo.test' : `driver${index + 1}@demo.test`,
    ),
  };
}

const options = parseOptions();

/**
 * Metres per second while responding: about 47 km/h, which is what an
 * ambulance with right of way actually averages through a city -- fast between
 * junctions, slow through them.
 */
const RESPONSE_SPEED_MPS = 13;
/** A slow crawl while idle, so the map is alive without vehicles racing. */
const IDLE_SPEED_MPS = 1.5;
/** Close enough to count as arrived. */
const ARRIVAL_RADIUS_METRES = 45;
/**
 * How often each vehicle reports position, in real milliseconds.
 *
 * One second matches what a real crew device sends, and the map interpolates
 * between the fixes, so movement reads as continuous rather than as a jump per
 * second.
 */
const TICK_MS = 1000;

const log = (vehicle: string, message: string): void => {
  process.stdout.write(`[${new Date().toLocaleTimeString()}] ${vehicle.padEnd(12)} ${message}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${options.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${init.method ?? 'GET'} ${path}: ${message}`);
  }
  return payload as T;
}

/**
 * One simulated crew: its login, its socket, and a state machine that walks the
 * vehicle through a case.
 */
class SimulatedCrew {
  private token = '';
  private socket: Socket | null = null;
  private vehicleNumber = '?';
  private position: LatLng = { lat: 0, lng: 0 };
  private base: LatLng = { lat: 0, lng: 0 };
  /** Remaining waypoints of the route currently being driven. */
  private path: LatLng[] = [];
  /** Where this leg ends. Road routes stop at the nearest road, which can be
   *  tens of metres from the true destination, so the last stretch is driven
   *  straight at it once the waypoints run out. */
  private destination: LatLng | null = null;
  private busy = false;
  private currentRequestId: string | null = null;
  private stopped = false;

  constructor(private readonly email: string) {}

  async start(): Promise<void> {
    const auth = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: { email: this.email, password: env.SEED_PASSWORD },
    });
    this.token = auth.accessToken;

    const shift = await api<{
      ambulance: { id: string; vehicleNumber: string; location: LatLng | null; status: string };
      activeRequest: EmergencyRequestDto | null;
    }>('/api/driver/shift', { token: this.token });
    this.vehicleNumber = shift.ambulance.vehicleNumber;
    this.position = shift.ambulance.location ?? { lat: 17.385, lng: 78.4867 };
    this.base = { ...this.position };

    if (shift.ambulance.status === 'OFFLINE') {
      await api('/api/driver/duty', {
        method: 'POST',
        token: this.token,
        body: { status: 'AVAILABLE' },
      });
      log(this.vehicleNumber, 'came on duty');
    }

    this.connectSocket();
    void this.loop();

    // A case left in flight by a previous run, an API restart or a dropped
    // connection. The patient is still waiting on it.
    if (shift.activeRequest) {
      log(
        this.vehicleNumber,
        `resuming ${shift.activeRequest.code} (${shift.activeRequest.status})`,
      );
      void this.workCase(shift.activeRequest.id);
    }
  }

  private connectSocket(): void {
    const socket = connectSocket(options.apiUrl, {
      auth: { token: this.token },
      transports: ['websocket'],
      reconnection: true,
    });

    socket.on('dispatch:offer', (offer: DispatchOfferDto) => {
      void this.handleOffer(offer);
    });

    socket.on('dispatch:offer_revoked', ({ reason }: { reason: string }) => {
      log(this.vehicleNumber, `offer withdrawn (${reason})`);
    });

    socket.on('connect_error', (error: Error) => {
      log(this.vehicleNumber, `socket error: ${error.message}`);
    });

    // A reconnect means this crew was out of touch for a while. The server may
    // still be holding a case for them, and an offer sent during the outage is
    // gone for good -- so ask rather than wait to be told.
    socket.on('connect', () => {
      void this.resumeActiveCase();
    });

    this.socket = socket;
  }

  private async handleOffer(offer: DispatchOfferDto): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.currentRequestId = offer.requestId;

    // A human crew takes a moment to read the card and press accept.
    await sleep(1200 + Math.random() * 1800);

    try {
      await api('/api/driver/offer', {
        method: 'POST',
        token: this.token,
        body: { requestId: offer.requestId, accept: true },
      });
      log(this.vehicleNumber, `accepted ${offer.code} (${offer.priority}) - responding`);
      await this.workCase(offer.requestId);
    } catch (error) {
      log(this.vehicleNumber, `could not take ${offer.code}: ${(error as Error).message}`);
      this.busy = false;
      this.currentRequestId = null;
      this.path = [];
    }
  }

  /**
   * Works a case through to closure, starting from whatever state it is
   * currently in.
   *
   * Each turn of the loop re-reads the case from the server rather than
   * trusting local state. That is what lets a crew pick up a case it was
   * already part-way through -- after a dropped socket or an API restart, a
   * crew that simply forgot would leave a patient waiting at the roadside
   * forever with a vehicle committed to them.
   */
  private async workCase(requestId: string): Promise<void> {
    this.busy = true;
    this.currentRequestId = requestId;

    try {
      // Bounded, so a case that refuses to advance cannot spin indefinitely.
      for (let step = 0; step < 24 && !this.stopped; step += 1) {
        const { request } = await api<{ request: EmergencyRequestDto }>(
          `/api/emergency/${requestId}`,
          { token: this.token },
        );

        switch (request.status) {
          case 'ASSIGNED':
            await this.advance('EN_ROUTE_TO_SCENE');
            break;

          case 'EN_ROUTE_TO_SCENE':
            // Reuse the server's own route so the vehicle follows streets
            // rather than cutting across the city in a straight line.
            await this.loadRouteFromServer(requestId, request.pickup);
            await this.driveTo(request.pickup);
            if (this.stopped) return;
            await this.advance('ON_SCENE');
            break;

          case 'ON_SCENE': {
            log(this.vehicleNumber, `on scene for ${request.code} - treating patient`);
            await sleep(20_000 / options.speed + Math.random() * 5000);
            if (this.stopped) return;

            if (!request.hospital) {
              log(this.vehicleNumber, 'no destination hospital; closing case');
              await this.advance('COMPLETED');
              break;
            }
            await this.advance('TRANSPORTING', { destinationHospitalId: request.hospital.id });
            log(this.vehicleNumber, `transporting to ${request.hospital.name}`);
            break;
          }

          case 'TRANSPORTING': {
            if (!request.hospital) {
              await this.advance('COMPLETED');
              break;
            }
            await this.loadRouteFromServer(requestId, request.hospital.location);
            await this.driveTo(request.hospital.location);
            if (this.stopped) return;
            await this.advance('ARRIVED_AT_HOSPITAL');
            break;
          }

          case 'ARRIVED_AT_HOSPITAL':
            await sleep(6000 / options.speed);
            await this.advance('COMPLETED');
            break;

          default:
            // COMPLETED, CANCELLED, or anything else this crew cannot advance.
            log(this.vehicleNumber, `case ${request.code} is now ${request.status}`);
            return;
        }

        // A breather, so a status the server refuses to change cannot become a
        // tight request loop.
        await sleep(400);
      }
    } catch (error) {
      log(this.vehicleNumber, `case handling failed: ${(error as Error).message}`);
    } finally {
      this.release();
    }
  }

  /**
   * Picks up a case this crew is still committed to.
   *
   * Called on start and on every reconnect: the server is the authority on
   * whether this vehicle owes a patient a journey.
   */
  private async resumeActiveCase(): Promise<void> {
    if (this.busy || this.stopped) return;

    try {
      const shift = await api<{ activeRequest: EmergencyRequestDto | null }>('/api/driver/shift', {
        token: this.token,
      });
      if (!shift.activeRequest) return;

      log(
        this.vehicleNumber,
        `resuming ${shift.activeRequest.code} (${shift.activeRequest.status})`,
      );
      await this.workCase(shift.activeRequest.id);
    } catch {
      /* The next reconnect will try again. */
    }
  }

  private release(): void {
    this.busy = false;
    this.currentRequestId = null;
    this.path = [];
    this.destination = null;
  }

  private async advance(
    status: 'EN_ROUTE_TO_SCENE' | 'ON_SCENE' | 'TRANSPORTING' | 'ARRIVED_AT_HOSPITAL' | 'COMPLETED',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.currentRequestId) return;
    try {
      await api('/api/driver/status', {
        method: 'POST',
        token: this.token,
        body: { requestId: this.currentRequestId, status, ...extra },
      });
    } catch (error) {
      log(this.vehicleNumber, `status ${status} rejected: ${(error as Error).message}`);
    }
  }

  /** Adopts the server's computed route as this vehicle's path. */
  private async loadRouteFromServer(requestId: string, fallback: LatLng): Promise<void> {
    try {
      const { request } = await api<{ request: EmergencyRequestDto }>(
        `/api/emergency/${requestId}`,
        { token: this.token },
      );
      const points = request.route?.points ?? [];
      this.path = points.length > 2 ? points : [this.position, fallback];
    } catch {
      this.path = [this.position, fallback];
    }
  }

  /** Blocks until the vehicle reaches `destination` or the simulator stops. */
  private async driveTo(destination: LatLng): Promise<void> {
    this.destination = destination;
    const timeoutAt = Date.now() + 15 * 60 * 1000;
    while (!this.stopped && haversineMetres(this.position, destination) > ARRIVAL_RADIUS_METRES) {
      if (Date.now() > timeoutAt) {
        log(this.vehicleNumber, 'route timed out; jumping to destination');
        this.position = destination;
        break;
      }
      await sleep(TICK_MS);
    }
    this.destination = null;
  }

  /**
   * The movement loop: one step per tick, following the current path when the
   * vehicle is on a case and drifting near base when it is not.
   */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      const metresThisTick =
        (this.busy ? RESPONSE_SPEED_MPS : IDLE_SPEED_MPS) * options.speed * (TICK_MS / 1000);

      const before = { ...this.position };

      if (this.busy && this.path.length > 0) {
        this.followPath(metresThisTick);
      } else if (this.busy && this.destination) {
        // Waypoints exhausted but not yet arrived: close the final gap between
        // the road the route ended on and the actual destination.
        this.driveStraightAt(this.destination, metresThisTick);
      } else if (!this.busy) {
        this.wander(metresThisTick);
      }

      // Derived from the ground actually covered, not from the speed the
      // vehicle would travel if it were moving. A crew parked on scene reports
      // a real zero rather than a cruising speed nobody is doing.
      const movedMetres = haversineMetres(before, this.position);

      this.socket?.emit('driver:location', {
        lat: this.position.lat,
        lng: this.position.lng,
        speed: movedMetres / (TICK_MS / 1000) / options.speed,
      });

      await sleep(TICK_MS);
    }
  }

  /** Advances along the waypoint list, consuming segments as they are passed. */
  private followPath(metres: number): void {
    let remaining = metres;

    while (remaining > 0 && this.path.length > 0) {
      const target = this.path[0];
      if (!target) break;

      const distance = haversineMetres(this.position, target);
      if (distance <= remaining) {
        this.position = target;
        remaining -= distance;
        this.path.shift();
      } else {
        this.position = interpolate(this.position, target, remaining / distance);
        remaining = 0;
      }
    }
  }

  /** Moves directly towards a point, stopping once it is reached. */
  private driveStraightAt(target: LatLng, metres: number): void {
    const distance = haversineMetres(this.position, target);
    if (distance <= metres) {
      this.position = target;
      return;
    }
    this.position = interpolate(this.position, target, metres / distance);
  }

  /** Idle drift: a slow random walk that stays within ~1.2 km of base. */
  private wander(metres: number): void {
    const degreesPerMetre = 1 / 111_320;
    const angle = Math.random() * Math.PI * 2;
    const candidate = {
      lat: this.position.lat + Math.sin(angle) * metres * degreesPerMetre,
      lng:
        this.position.lng +
        (Math.cos(angle) * metres * degreesPerMetre) /
          Math.cos((this.position.lat * Math.PI) / 180),
    };

    this.position =
      haversineMetres(this.base, candidate) > 1200
        ? interpolate(this.position, this.base, 0.05)
        : candidate;
  }

  stop(): void {
    this.stopped = true;
    this.socket?.disconnect();
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `\nFleet simulator -> ${options.apiUrl}  (${options.speed}x speed, ${options.drivers.length} crews)\n` +
      `Press Ctrl+C to stop.\n\n`,
  );

  // Wait for the API rather than failing on a race with `npm run dev`.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await api('/api/health');
      break;
    } catch {
      if (attempt === 29) throw new Error(`API at ${options.apiUrl} did not become reachable`);
      await sleep(1000);
    }
  }

  const crews: SimulatedCrew[] = [];
  for (const email of options.drivers) {
    const crew = new SimulatedCrew(email);
    try {
      await crew.start();
      crews.push(crew);
    } catch (error) {
      process.stdout.write(`  skipped ${email}: ${(error as Error).message}\n`);
    }
    // Stagger the logins so ten bcrypt verifications do not land at once.
    await sleep(250);
  }

  if (crews.length === 0) {
    throw new Error('No crews could start. Has the database been seeded? Run: npm run seed');
  }
  process.stdout.write(`\n${crews.length} crews are live and waiting for dispatch.\n\n`);

  const shutdown = (): void => {
    process.stdout.write('\nStopping simulator...\n');
    for (const crew of crews) crew.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`\nSimulator failed: ${(error as Error).message}\n`);
  process.exit(1);
});
