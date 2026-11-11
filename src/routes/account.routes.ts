import { Router } from 'express';

import * as accountController from '../controllers/account.controller.ts';
import { employeeProfileController } from '../controllers/employee-profile.controller.ts';

import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// Se monta en /api/me (ver app.ts), como dice el contrato.
// Todas las rutas de este módulo requieren autenticación.
router.use(authenticateToken);

// ============================================================
// DATOS PERSONALES
// ============================================================

router.get('/', accountController.getMe);

router.patch('/', accountController.updateMe);

router.patch('/password', accountController.changePassword);

// ============================================================
// PERFIL DE EMPLEADO
// ============================================================

router.get('/employee-profile', employeeProfileController.getMyEmployeeProfile);

// ============================================================
// DIRECCIONES
// ============================================================

router.get('/addresses', accountController.listAddresses);

router.post('/addresses', accountController.createAddress);

router.get('/addresses/:id', accountController.getAddress);

router.patch('/addresses/:id/main', accountController.setMain);

router.patch('/addresses/:id', accountController.updateAddress);

router.delete('/addresses/:id', accountController.deactivateAddress);

export default router;
