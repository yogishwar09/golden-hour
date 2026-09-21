import { Router } from 'express';
import { authRoutes } from './auth.routes.js';
import { emergencyRoutes } from './emergency.routes.js';
import { driverRoutes } from './driver.routes.js';
import { ambulanceRoutes, hospitalRoutes } from './fleet.routes.js';
import { adminRoutes } from './admin.routes.js';
import { statsRoutes } from './stats.routes.js';

export const apiRoutes = Router();

apiRoutes.use('/auth', authRoutes);
apiRoutes.use('/emergency', emergencyRoutes);
apiRoutes.use('/driver', driverRoutes);
apiRoutes.use('/ambulances', ambulanceRoutes);
apiRoutes.use('/hospitals', hospitalRoutes);
apiRoutes.use('/admin', adminRoutes);
apiRoutes.use('/stats', statsRoutes);
