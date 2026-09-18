import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { CreateEmergencyInput, EmergencyRequestDto, Paginated } from '@sas/shared';
import { EmergencyRequest } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  cancelRequest,
  createEmergencyRequest,
  getVisibleRequest,
  rateRequest,
} from '../services/request.service.js';
import { REQUEST_POPULATION, serializeRequest } from '../services/serialize.js';

export const createRequest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const dto = await createEmergencyRequest(req.user, req.body as CreateEmergencyInput, {
    ip: req.ip,
  });
  res.status(201).json({ request: dto });
});

export const listMyRequests = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  // Set by `validate(paginationSchema, 'query')`, so these are already numbers.
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const filter = { patient: req.user._id };
  const [docs, total] = await Promise.all([
    EmergencyRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(REQUEST_POPULATION as unknown as string[]),
    EmergencyRequest.countDocuments(filter),
  ]);

  const body: Paginated<EmergencyRequestDto> = {
    items: docs.map(serializeRequest),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
  res.json(body);
});

/** The caller's currently open case, if they have one. Drives the SOS screen. */
export const getActiveRequest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const doc = await EmergencyRequest.findOne({
    patient: req.user._id,
    status: {
      $in: [
        'PENDING',
        'SEARCHING',
        'ASSIGNED',
        'EN_ROUTE_TO_SCENE',
        'ON_SCENE',
        'TRANSPORTING',
        'ARRIVED_AT_HOSPITAL',
      ],
    },
  })
    .sort({ createdAt: -1 })
    .populate(REQUEST_POPULATION as unknown as string[]);

  res.json({ request: doc ? serializeRequest(doc) : null });
});

export const getRequest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = req.params.id;
  if (!id) throw ApiError.badRequest('A request id is required');

  const dto = await getVisibleRequest(id, { id: req.user._id.toString(), role: req.user.role });
  res.json({ request: dto });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid request id');

  const dto = await cancelRequest({
    requestId: id,
    actorId: req.user._id.toString(),
    actorRole: req.user.role,
    reason: (req.body as { reason: string }).reason,
  });
  res.json({ request: dto });
});

export const rate = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid request id');

  const { stars, comment } = req.body as { stars: number; comment?: string };
  const dto = await rateRequest({
    requestId: id,
    patientId: req.user._id.toString(),
    stars,
    ...(comment ? { comment } : {}),
  });
  res.json({ request: dto });
});
