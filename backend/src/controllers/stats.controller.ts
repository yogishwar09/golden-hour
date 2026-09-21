/**
 * Figures any signed-in user may see.
 *
 * Separate from `admin.controller` on purpose: that one exposes live cases,
 * users and the audit trail. Everything here is aggregate-only -- counts and
 * averages, never a case, a person or a location -- because a patient sees it.
 */

import type { Request, Response } from 'express';
import {
  PRIORITIES,
  PRIORITY_SLA_MINUTES,
  TERMINAL_REQUEST_STATUSES,
  type MyStatsDto,
  type ServiceStatsDto,
} from '@sas/shared';
import { Ambulance, EmergencyRequest, Hospital } from '../models/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/**
 * The service's own record: how many people it has helped and how fast.
 *
 * Every figure is computed in the database rather than by loading documents,
 * so this stays cheap as case volume grows -- it is on the screen a caller
 * looks at before pressing SOS, so it must never be the slow part.
 */
export const getServiceStats = asyncHandler(async (_req: Request, res: Response) => {
  const since = startOfToday();

  const [completedTotal, completedToday, activeNow, responseRows, fleetRows, hospitals] =
    await Promise.all([
      EmergencyRequest.countDocuments({ status: 'COMPLETED' }),
      EmergencyRequest.countDocuments({ status: 'COMPLETED', createdAt: { $gte: since } }),
      EmergencyRequest.countDocuments({ status: { $nin: TERMINAL_REQUEST_STATUSES } }),
      EmergencyRequest.aggregate<{ _id: null; avg: number; met: number; total: number }>([
        { $match: { responseSeconds: { $ne: null } } },
        {
          $group: {
            _id: null,
            avg: { $avg: '$responseSeconds' },
            total: { $sum: 1 },
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
      Ambulance.aggregate<{ _id: null; total: number; available: number }>([
        { $match: { isActive: true } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            available: { $sum: { $cond: [{ $eq: ['$status', 'AVAILABLE'] }, 1, 0] } },
          },
        },
      ]),
      Hospital.countDocuments({ isActive: true }),
    ]);

  const response = responseRows[0];
  const fleet = fleetRows[0];

  const body: ServiceStatsDto = {
    casesCompleted: completedTotal,
    casesCompletedToday: completedToday,
    activeNow,
    averageResponseSeconds: response ? Math.round(response.avg) : null,
    ambulancesAvailable: fleet?.available ?? 0,
    ambulancesTotal: fleet?.total ?? 0,
    hospitalsCovered: hospitals,
    slaComplianceRate: response && response.total > 0 ? response.met / response.total : null,
  };

  res.json(body);
});

/** The caller's own record. Scoped to them; no other patient is visible. */
export const getMyStats = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const [total, completed, responseRows, latest] = await Promise.all([
    EmergencyRequest.countDocuments({ patient: req.user._id }),
    EmergencyRequest.countDocuments({ patient: req.user._id, status: 'COMPLETED' }),
    EmergencyRequest.aggregate<{ _id: null; avg: number }>([
      { $match: { patient: req.user._id, responseSeconds: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$responseSeconds' } } },
    ]),
    EmergencyRequest.findOne({ patient: req.user._id }).sort({ createdAt: -1 }).select('createdAt'),
  ]);

  const body: MyStatsDto = {
    totalRequests: total,
    completed,
    averageResponseSeconds: responseRows[0] ? Math.round(responseRows[0].avg) : null,
    lastRequestAt: latest ? latest.createdAt.toISOString() : null,
  };

  res.json(body);
});
