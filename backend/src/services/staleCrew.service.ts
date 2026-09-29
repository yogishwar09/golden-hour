/**
 * Takes vehicles off duty when their crew stops reporting.
 *
 * A vehicle is dispatchable because a crew signed on to it, and the only
 * evidence that the crew is still there is that the device keeps reporting its
 * position. When that stops -- the app was closed, the phone died, the
 * simulator driving a demo fleet was shut down -- the vehicle stays marked
 * AVAILABLE and the dispatcher keeps offering it cases that nobody will ever
 * answer. Each of those offers costs a patient the full offer timeout before
 * the case moves on, and enough of them exhaust the cascade entirely.
 *
 * This is what that failure looked like in practice: a demonstration
 * deployment whose crews had gone hours earlier still showed twenty-five
 * available ambulances, and every emergency raised against it sat at "finding
 * nearest ambulance" until it gave up.
 *
 * A vehicle already working a case is never touched. Losing contact with a
 * crew that has a patient is a dispatcher's problem to resolve, not something
 * to paper over by quietly marking the vehicle free.
 */

import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { Ambulance } from '../models/index.js';
import { realtime } from './realtime.service.js';

let timer: NodeJS.Timeout | null = null;

/** How often to sweep. Frequent enough to matter, cheap enough not to. */
const SWEEP_INTERVAL_MS = 60_000;

export async function sweepStaleCrews(): Promise<number> {
  const cutoff = new Date(Date.now() - env.CREW_SILENCE_TIMEOUT_SECONDS * 1000);

  const stale = await Ambulance.find({
    isActive: true,
    // Only vehicles that are notionally ready for work. A crew that is
    // mid-case is deliberately excluded.
    status: { $in: ['AVAILABLE', 'OFFERED'] },
    activeRequest: null,
    $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: null }],
  }).select('_id vehicleNumber');

  if (stale.length === 0) return 0;

  await Ambulance.updateMany(
    { _id: { $in: stale.map((vehicle) => vehicle._id) } },
    { $set: { status: 'OFFLINE', offerExpiresAt: null } },
  );

  for (const vehicle of stale) realtime.ambulanceStatus(vehicle._id.toString(), 'OFFLINE');

  logger.warn(
    { count: stale.length, vehicles: stale.slice(0, 5).map((v) => v.vehicleNumber) },
    'Took vehicles off duty: their crews stopped reporting',
  );
  return stale.length;
}

export function startStaleCrewSweep(): void {
  if (env.isTest) return;

  timer = setInterval(() => {
    void sweepStaleCrews().catch((error: unknown) => {
      logger.error({ err: error }, 'Stale crew sweep failed');
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopStaleCrewSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
