import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';
import {
  activeClientServiceController,
  getClientServiceController,
  listClientServicesController,
} from '../controllers/client-history.controller.ts';

const router = Router();

// Historial de servicios del cliente (API-48): solo clientes.
router.use(authenticateToken, authorizeRoles('cliente'));

router.get('/', listClientServicesController);
// Va antes de '/:id' para que "active" no se tome como un id.
router.get('/active', activeClientServiceController);
router.get('/:id', getClientServiceController);

export default router;
