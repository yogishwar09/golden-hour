/**
 * A caller's past requests, and the place to rate a completed one.
 */

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Clock, FileText, Star } from 'lucide-react';
import {
  EMERGENCY_TYPE_LABELS,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  type EmergencyRequestDto,
  type Paginated,
} from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { StatusTimeline } from '../components/StatusTimeline';
import { Card, EmptyState, ErrorNotice, Skeleton } from '../components/ui';
import {
  formatDateTime,
  formatDurationShort,
  PRIORITY_STYLES,
  REQUEST_STATUS_STYLES,
} from '../lib/format';

export function History() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<EmergencyRequestDto> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<Paginated<EmergencyRequestDto>>('/emergency/mine', {
        params: { page, limit: 10 },
      });
      setData(response.data);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const rate = useCallback(
    async (requestId: string, stars: number): Promise<void> => {
      try {
        await api.post(`/emergency/${requestId}/rate`, { stars });
        toast.success('Thank you for the feedback.');
        await load();
      } catch (caught) {
        toast.error(errorMessage(caught));
      }
    },
    [load],
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My requests</h1>
        <p className="mt-1 text-sm text-ink-400">Every emergency you have raised.</p>
      </div>

      {error && <ErrorNotice message={error} />}

      {!data ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title="No requests yet"
            description="Emergencies you raise will be listed here with their full timeline."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.items.map((item) => {
            const isOpen = expandedId === item.id;
            return (
              <Card key={item.id} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : item.id)}
                  className="w-full px-5 py-4 text-left transition-colors hover:bg-ink-800/50"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`chip ${PRIORITY_STYLES[item.priority]}`}>
                      {PRIORITY_LABELS[item.priority]}
                    </span>
                    <span className="numeric text-xs font-semibold text-ink-300">{item.code}</span>
                    <span className={`chip ml-auto ${REQUEST_STATUS_STYLES[item.status]}`}>
                      {REQUEST_STATUS_LABELS[item.status]}
                    </span>
                  </div>

                  <p className="mt-2 font-semibold">
                    {EMERGENCY_TYPE_LABELS[item.emergencyType]}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
                    <span>{formatDateTime(item.createdAt)}</span>
                    {item.ambulance && <span className="numeric">{item.ambulance.vehicleNumber}</span>}
                    {item.responseSeconds !== null && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" aria-hidden />
                        On scene in {formatDurationShort(item.responseSeconds)}
                      </span>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="space-y-4 border-t border-ink-700 px-5 py-4">
                    <StatusTimeline status={item.status} events={item.timeline} />

                    {item.hospital && (
                      <p className="text-sm text-ink-300">
                        Taken to <span className="font-semibold">{item.hospital.name}</span>
                      </p>
                    )}
                    {item.cancellationReason && (
                      <p className="text-sm text-ink-300">
                        Cancelled: {item.cancellationReason}
                      </p>
                    )}

                    {item.status === 'COMPLETED' && (
                      <div>
                        <p className="label">
                          {item.rating ? 'Your rating' : 'How did we do?'}
                        </p>
                        <div className="flex gap-1">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <button
                              key={star}
                              type="button"
                              disabled={Boolean(item.rating)}
                              onClick={() => rate(item.id, star)}
                              aria-label={`Rate ${star} out of 5`}
                              className="p-0.5 transition-transform enabled:hover:scale-110 disabled:cursor-default"
                            >
                              <Star
                                className={`h-6 w-6 ${
                                  (item.rating?.stars ?? 0) >= star
                                    ? 'fill-amber-400 text-amber-400'
                                    : 'text-ink-600'
                                }`}
                                aria-hidden
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}

          {data.pages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>
              <span className="text-sm text-ink-400">
                Page {data.page} of {data.pages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= data.pages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
