import { Router } from 'express';

import { getAdminDashboardController } from '../controllers/admin-dashboard.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

/** Resumen del tablero del panel (API-52). Se monta en /api/admin; solo para el Administrador. */
export const adminDashboardRouter = Router();

adminDashboardRouter.use(authenticateToken, authorizeRoles('administrador'));

adminDashboardRouter.get('/dashboard', getAdminDashboardController);
