import { Router } from 'express';

import { getProviderStatsController } from '../controllers/provider-stats.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

/** Estadísticas del proveedor por periodo y sucursal (API-44). Se monta en /api/stats. */
const router = Router();

router.use(authenticateToken, authorizeRoles('proveedor', 'gerente', 'empleado', 'administrador'));

router.get('/', getProviderStatsController);

export default router;
