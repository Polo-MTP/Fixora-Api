import { Router } from 'express';
import {
  getCommissionSettingsController,
  listIncomeController,
  markCommissionPaidController,
  setCommissionPercentageController,
} from '../controllers/admin-income.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

/** Ingresos y comisiones (API-38). Se monta en /api/admin; solo para el Administrador. */
export const adminIncomeRouter = Router();

adminIncomeRouter.use(authenticateToken, authorizeRoles('administrador'));

adminIncomeRouter.get('/income', listIncomeController);
adminIncomeRouter.post('/income/:id/commission-paid', markCommissionPaidController);
adminIncomeRouter.get('/commission-settings', getCommissionSettingsController);
adminIncomeRouter.put('/commission-settings', setCommissionPercentageController);
