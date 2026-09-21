import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getMyStats, getServiceStats } from '../controllers/stats.controller.js';

export const statsRoutes = Router();

// Any signed-in user. The payloads are aggregate-only, so no role gate is
// needed beyond being authenticated.
statsRoutes.use(requireAuth);
statsRoutes.get('/service', getServiceStats);
statsRoutes.get('/me', getMyStats);
