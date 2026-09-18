import type { Request, Response } from 'express';
import type { AuthResponse, LoginInput, RegisterInput, UpdateProfileInput } from '@sas/shared';
import { env } from '../config/env.js';
import { User, hashPassword } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { signAccessToken } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.service.js';

/**
 * Self-service registration is limited to patients and drivers. Hospital and
 * admin accounts are provisioned by an existing admin, so nobody can grant
 * themselves control-room access by choosing a role on the signup form.
 */
const SELF_SERVICE_ROLES = new Set(['patient', 'driver']);

export const register = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as RegisterInput;

  if (!SELF_SERVICE_ROLES.has(input.role)) {
    throw ApiError.forbidden('Hospital and administrator accounts are created by an administrator');
  }

  const existing = await User.findOne({ email: input.email });
  if (existing) throw ApiError.conflict('An account with that email already exists');

  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    bloodGroup: input.bloodGroup,
    emergencyContact: input.emergencyContact,
    medicalNotes: input.medicalNotes,
  });

  recordAudit({
    actorId: user._id.toString(),
    actorRole: user.role,
    action: 'auth.registered',
    entityType: 'User',
    entityId: user._id.toString(),
    ip: req.ip,
  });

  const body: AuthResponse = {
    user: user.toDto(),
    accessToken: signAccessToken(user._id.toString(), user.role),
    expiresIn: env.JWT_TTL_SECONDS,
  };
  res.status(201).json(body);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as LoginInput;

  // `passwordHash` is `select: false`, so it must be asked for explicitly.
  const user = await User.findOne({ email: input.email }).select('+passwordHash');

  // The same message for an unknown email and a wrong password, so the endpoint
  // cannot be used to enumerate which addresses have accounts.
  const invalid = ApiError.unauthorized('That email or password is not correct');
  if (!user) throw invalid;
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');
  if (!(await user.verifyPassword(input.password))) throw invalid;

  user.lastLoginAt = new Date();
  await user.save();

  recordAudit({
    actorId: user._id.toString(),
    actorRole: user.role,
    action: 'auth.login',
    entityType: 'User',
    entityId: user._id.toString(),
    ip: req.ip,
  });

  const body: AuthResponse = {
    user: user.toDto(),
    accessToken: signAccessToken(user._id.toString(), user.role),
    expiresIn: env.JWT_TTL_SECONDS,
  };
  res.json(body);
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  res.json({ user: req.user.toDto() });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const input = req.body as UpdateProfileInput;

  // Assigned field by field: a role or an isActive flag in the body is ignored.
  if (input.name !== undefined) req.user.name = input.name;
  if (input.phone !== undefined) req.user.phone = input.phone;
  if (input.bloodGroup !== undefined) req.user.bloodGroup = input.bloodGroup;
  if (input.emergencyContact !== undefined) req.user.emergencyContact = input.emergencyContact;
  if (input.medicalNotes !== undefined) req.user.medicalNotes = input.medicalNotes;

  await req.user.save();
  res.json({ user: req.user.toDto() });
});
