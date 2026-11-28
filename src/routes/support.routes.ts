import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';
import {
  assignInboxController,
  listInboxController,
  resolveInboxController,
  serviceTimelineController,
} from '../controllers/support.controller.ts';

const router = Router();

// Endpoints de Soporte (API-41): solo Soporte y Administrador.
router.use(authenticateToken, authorizeRoles('soporte', 'administrador'));

// Bandeja de reportes, garantías y reclamaciones.
router.get('/inbox', listInboxController);
router.post('/inbox/:id/assign', assignInboxController);
router.post('/inbox/:id/resolve', resolveInboxController);

// Historial auditable de un servicio.
router.get('/service-requests/:id/timeline', serviceTimelineController);

export default router;
