import { Router } from 'express';
import { advanceStatusSchema, locationPingSchema, offerResponseSchema, setDutyStatusSchema } from '@sas/shared';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  advanceStatus,
  getMyShift,
  pushLocation,
  respondToOffer,
  setDutyStatus,
} from '../controllers/driver.controller.js';

export const driverRoutes = Router();

driverRoutes.use(requireAuth, requireRole('driver'));

driverRoutes.get('/shift', getMyShift);
driverRoutes.post('/duty', validate(setDutyStatusSchema), setDutyStatus);
driverRoutes.post('/offer', validate(offerResponseSchema), respondToOffer);
driverRoutes.post('/status', validate(advanceStatusSchema), advanceStatus);
driverRoutes.post('/location', validate(locationPingSchema), pushLocation);
