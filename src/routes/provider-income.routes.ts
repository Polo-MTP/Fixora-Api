import { Router } from 'express';

import { listProviderIncomeController } from '../controllers/provider-income.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

/**
 * Ingresos del proveedor por servicio (API-46). Se monta en /api/income. Son del negocio: los ven
 * el dueño y el gerente, no cada técnico.
 */
const router = Router();

router.use(authenticateToken, authorizeRoles('proveedor', 'gerente'));

router.get('/', listProviderIncomeController);

export default router;
