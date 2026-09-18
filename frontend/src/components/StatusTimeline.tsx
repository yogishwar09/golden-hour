/**
 * The case timeline.
 *
 * Shows the full journey as a fixed set of steps rather than only what has
 * happened, so a caller can see what is still to come. The steps shown depend
 * on how the case ended: a cancelled case should not display the four stages it
 * never reached.
 */

import { Check } from 'lucide-react';
import { CREW_PROGRESSION, REQUEST_STATUS_LABELS, type RequestStatus } from '@sas/shared';
import type { TimelineEventDto } from '@sas/shared';
import { formatClock } from '../lib/format';

const FULL_JOURNEY: RequestStatus[] = ['PENDING', 'SEARCHING', ...CREW_PROGRESSION];

export function StatusTimeline({
  status,
  events,
}: {
  status: RequestStatus;
  events: TimelineEventDto[];
}) {
  const ended = ['CANCELLED', 'NO_AMBULANCE_AVAILABLE'].includes(status);

  // For a case that ended early, show only what actually happened plus the
  // terminal event; showing unreachable future steps would be misleading.
  const steps = ended ? events.map((event) => event.status) : FULL_JOURNEY;

  const timeFor = (step: RequestStatus): string | null => {
    const match = events.find((event) => event.status === step);
    return match ? formatClock(match.at) : null;
  };

  const currentIndex = steps.lastIndexOf(status);

  return (
    <ol className="relative space-y-0.5">
      {steps.map((step, index) => {
        const reachedAt = timeFor(step);
        const isDone = index < currentIndex || (index === currentIndex && ended);
        const isCurrent = index === currentIndex && !ended;
        const isFuture = index > currentIndex;
        const isLast = index === steps.length - 1;

        return (
          <li key={`${step}-${index}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isCurrent
                    ? 'border-emergency-500 bg-emergency-500/20'
                    : isDone
                      ? 'border-emerald-500/70 bg-emerald-500/20'
                      : 'border-ink-600 bg-ink-800'
                }`}
              >
                {isDone ? (
                  <Check className="h-3 w-3 text-emerald-300" aria-hidden />
                ) : isCurrent ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emergency-400" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-ink-500" />
                )}
              </span>
              {!isLast && (
                <span
                  className={`w-0.5 flex-1 ${isDone ? 'bg-emerald-500/40' : 'bg-ink-700'}`}
                  style={{ minHeight: 18 }}
                />
              )}
            </div>

            <div className={`flex-1 pb-3 ${isLast ? 'pb-0' : ''}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p
                  className={`text-sm font-semibold ${
                    isFuture ? 'text-ink-500' : isCurrent ? 'text-emergency-300' : 'text-ink-100'
                  }`}
                >
                  {REQUEST_STATUS_LABELS[step]}
                </p>
                {reachedAt && <span className="numeric text-xs text-ink-400">{reachedAt}</span>}
              </div>
              {events.find((event) => event.status === step)?.note && (
                <p className="mt-0.5 text-xs text-ink-400">
                  {events.find((event) => event.status === step)?.note}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
