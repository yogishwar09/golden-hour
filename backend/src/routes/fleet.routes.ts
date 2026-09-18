import { Router } from 'express';
import {
  createAmbulanceSchema,
  createHospitalSchema,
  nearbyQuerySchema,
  updateAmbulanceSchema,
  updateBedsSchema,
} from '@sas/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createAmbulance,
  createHospital,
  listAmbulances,
  listHospitals,
  nearbyAmbulances,
  nearbyHospitals,
  retireAmbulance,
  updateAmbulance,
  updateBeds,
} from '../controllers/fleet.controller.js';

export const ambulanceRoutes = Router();

ambulanceRoutes.use(requireAuth);
ambulanceRoutes.get('/nearby', validate(nearbyQuerySchema, 'query'), nearbyAmbulances);
ambulanceRoutes.get('/', requireRole('admin', 'hospital'), listAmbulances);
ambulanceRoutes.post('/', requireRole('admin'), validate(createAmbulanceSchema), createAmbulance);
ambulanceRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate(updateAmbulanceSchema),
  updateAmbulance,
);
ambulanceRoutes.delete('/:id', requireRole('admin'), retireAmbulance);

export const hospitalRoutes = Router();

hospitalRoutes.use(requireAuth);
hospitalRoutes.get('/', listHospitals);
hospitalRoutes.get('/nearby', validate(nearbyQuerySchema, 'query'), nearbyHospitals);
hospitalRoutes.post('/', requireRole('admin'), validate(createHospitalSchema), createHospital);
// Hospital staff maintain their own bed counts; admins can correct any of them.
hospitalRoutes.patch(
  '/:id/beds',
  requireRole('admin', 'hospital'),
  validate(updateBedsSchema),
  updateBeds,
);
