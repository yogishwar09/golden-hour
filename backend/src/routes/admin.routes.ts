import { Router } from 'express';
import { z } from 'zod';
import { paginationSchema } from '@sas/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getStats,
  getTimeSeries,
  listActiveRequests,
  listAllRequests,
  listAuditLog,
  listUsers,
  setUserActive,
} from '../controllers/admin.controller.js';

export const adminRoutes = Router();

adminRoutes.use(requireAuth);

// Hospital staff share the live board and the headline figures, but not the
// user administration or the audit trail.
adminRoutes.get('/stats', requireRole('admin', 'hospital'), getStats);
adminRoutes.get('/timeseries', requireRole('admin', 'hospital'), getTimeSeries);
adminRoutes.get('/requests/active', requireRole('admin', 'hospital'), listActiveRequests);

adminRoutes.use(requireRole('admin'));
adminRoutes.get('/requests', validate(paginationSchema, 'query'), listAllRequests);
adminRoutes.get('/users', validate(paginationSchema, 'query'), listUsers);
adminRoutes.patch('/users/:id/active', validate(z.object({ isActive: z.boolean() })), setUserActive);
adminRoutes.get('/audit', validate(paginationSchema, 'query'), listAuditLog);
