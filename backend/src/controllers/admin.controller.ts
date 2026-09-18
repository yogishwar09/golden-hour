import type { Request, Response } from 'express';
import {
  AMBULANCE_STATUSES,
  PRIORITIES,
  PRIORITY_SLA_MINUTES,
  TERMINAL_REQUEST_STATUSES,
  type AmbulanceStatus,
  type FleetStatsDto,
  type Priority,
  type TimeSeriesPointDto,
} from '@sas/shared';
import { Ambulance, AuditLog, EmergencyRequest, Hospital, User } from '../models/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { REQUEST_POPULATION, serializeRequest } from '../services/serialize.js';

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/**
 * The control-room summary.
 *
 * Every figure is computed in the database rather than by loading documents
 * into the API, so the panel stays fast as case volume grows.
 */
export const getStats = asyncHandler(async (_req: Request, res: Response) => {
  const since = startOfToday();

  const [fleetCounts, todayCounts, activeRequests, responseStats, priorityCounts, bedTotals] =
    await Promise.all([
      Ambulance.aggregate<{ _id: AmbulanceStatus; count: number }>([
        { $match: { isActive: true } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      EmergencyRequest.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      EmergencyRequest.countDocuments({ status: { $nin: TERMINAL_REQUEST_STATUSES } }),
      EmergencyRequest.aggregate<{ _id: Priority; avg: number; met: number; total: number }>([
        { $match: { createdAt: { $gte: since }, responseSeconds: { $ne: null } } },
        {
          $group: {
            _id: '$priority',
            avg: { $avg: '$responseSeconds' },
            total: { $sum: 1 },
            // Compared against the per-priority target, evaluated in-database.
            met: {
              $sum: {
                $cond: [
                  {
                    $lte: [
                      '$responseSeconds',
                      {
                        $switch: {
                          branches: PRIORITIES.map((priority) => ({
                            case: { $eq: ['$priority', priority] },
                            then: PRIORITY_SLA_MINUTES[priority] * 60,
                          })),
                          default: 3600,
                        },
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      EmergencyRequest.aggregate<{ _id: Priority; count: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Hospital.aggregate<{ _id: null; total: number; available: number }>([
        { $match: { isActive: true } },
        {
          $group: {
            _id: null,
            total: { $sum: '$beds.total' },
            available: { $sum: '$beds.available' },
          },
        },
      ]),
    ]);

  const fleet = Object.fromEntries(AMBULANCE_STATUSES.map((status) => [status, 0])) as Record<
    AmbulanceStatus,
    number
  >;
  for (const row of fleetCounts) fleet[row._id] = row.count;

  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  for (const row of priorityCounts) byPriority[row._id] = row.count;

  const todayByStatus = new Map(todayCounts.map((row) => [row._id, row.count]));
  const requestsToday = todayCounts.reduce((sum, row) => sum + row.count, 0);

  const weightedResponse = responseStats.reduce(
    (acc, row) => ({ sum: acc.sum + row.avg * row.total, count: acc.count + row.total }),
    { sum: 0, count: 0 },
  );
  const slaTotals = responseStats.reduce(
    (acc, row) => ({ met: acc.met + row.met, total: acc.total + row.total }),
    { met: 0, total: 0 },
  );

  const body: FleetStatsDto = {
    fleet,
    activeRequests,
    requestsToday,
    completedToday: todayByStatus.get('COMPLETED') ?? 0,
    cancelledToday: todayByStatus.get('CANCELLED') ?? 0,
    averageResponseSeconds:
      weightedResponse.count > 0 ? Math.round(weightedResponse.sum / weightedResponse.count) : null,
    slaComplianceRate: slaTotals.total > 0 ? slaTotals.met / slaTotals.total : null,
    byPriority,
    hospitalBeds: {
      total: bedTotals[0]?.total ?? 0,
      available: bedTotals[0]?.available ?? 0,
    },
  };

  res.json(body);
});

/** Case volume per hour over the last 24 hours, for the control-room chart. */
export const getTimeSeries = asyncHandler(async (_req: Request, res: Response) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await EmergencyRequest.aggregate<{
    _id: string;
    requests: number;
    completed: number;
  }>([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%dT%H:00', date: '$createdAt' } },
        requests: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const body: TimeSeriesPointDto[] = rows.map((row) => ({
    bucket: row._id,
    requests: row.requests,
    completed: row.completed,
  }));
  res.json({ items: body });
});

/** Live board: everything currently open, most urgent and oldest first. */
export const listActiveRequests = asyncHandler(async (_req: Request, res: Response) => {
  const docs = await EmergencyRequest.find({ status: { $nin: TERMINAL_REQUEST_STATUSES } })
    .sort({ priority: 1, createdAt: 1 })
    .limit(200)
    .populate(REQUEST_POPULATION as unknown as string[]);

  res.json({ items: docs.map(serializeRequest) });
});

export const listAllRequests = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const [docs, total] = await Promise.all([
    EmergencyRequest.find({})
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(REQUEST_POPULATION as unknown as string[]),
    EmergencyRequest.countDocuments({}),
  ]);

  res.json({
    items: docs.map(serializeRequest),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const [users, total] = await Promise.all([
    User.find({})
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments({}),
  ]);

  res.json({
    items: users.map((user) => user.toDto()),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

/** Deactivating rather than deleting: cases must keep referring to real people. */
export const setUserActive = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) throw ApiError.badRequest('A user id is required');

  const { isActive } = req.body as { isActive: boolean };
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  if (user._id.toString() === req.user?._id.toString()) {
    throw ApiError.badRequest('You cannot deactivate your own account');
  }

  user.isActive = isActive;
  await user.save();
  res.json({ user: user.toDto() });
});

export const listAuditLog = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const [entries, total] = await Promise.all([
    AuditLog.find({})
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('actor', 'name email role'),
    AuditLog.countDocuments({}),
  ]);

  res.json({
    items: entries.map((entry) => ({
      id: entry._id.toString(),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorRole: entry.actorRole,
      meta: entry.meta,
      at: entry.createdAt.toISOString(),
    })),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});
