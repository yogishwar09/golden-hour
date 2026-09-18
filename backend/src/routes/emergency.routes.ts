import { Router } from 'express';
import {
  cancelEmergencySchema,
  createEmergencySchema,
  paginationSchema,
  rateEmergencySchema,
} from '@sas/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sosLimiter } from '../middleware/rateLimit.js';
import {
  cancel,
  createRequest,
  getActiveRequest,
  getRequest,
  listMyRequests,
  rate,
} from '../controllers/emergency.controller.js';

export const emergencyRoutes = Router();

emergencyRoutes.use(requireAuth);

// The SOS itself. Patients and admins only: a driver raising an emergency
// against their own account would take their vehicle out of service.
emergencyRoutes.post(
  '/',
  requireRole('patient', 'admin'),
  sosLimiter,
  validate(createEmergencySchema),
  createRequest,
);

emergencyRoutes.get('/mine', validate(paginationSchema, 'query'), listMyRequests);
emergencyRoutes.get('/active', getActiveRequest);
emergencyRoutes.get('/:id', getRequest);
emergencyRoutes.post('/:id/cancel', validate(cancelEmergencySchema), cancel);
emergencyRoutes.post('/:id/rate', validate(rateEmergencySchema), rate);
