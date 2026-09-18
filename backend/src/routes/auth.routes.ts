import { Router } from 'express';
import { loginSchema, registerSchema, updateProfileSchema } from '@sas/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { login, me, register, updateProfile } from '../controllers/auth.controller.js';

export const authRoutes = Router();

authRoutes.post('/register', authLimiter, validate(registerSchema), register);
authRoutes.post('/login', authLimiter, validate(loginSchema), login);
authRoutes.get('/me', requireAuth, me);
authRoutes.patch('/me', requireAuth, validate(updateProfileSchema), updateProfile);
