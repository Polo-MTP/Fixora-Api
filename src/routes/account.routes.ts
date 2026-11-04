
import { Router } from 'express';

import * as accountController from '../controllers/account.controller.ts';

import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// Todas las rutas de este módulo requieren autenticación.
router.use(authenticateToken);

// ============================================================
// DATOS PERSONALES
// ============================================================

router.get(
    '/me',
    accountController.getMe
);

router.patch(
    '/me',
    accountController.updateMe
);

router.patch(
    '/me/password',
    accountController.changePassword
);

// ============================================================
// DIRECCIONES
// ============================================================

router.get(
    '/addresses',
    accountController.listAddresses
);

router.post(
    '/addresses',
    accountController.createAddress
);

router.get(
    '/addresses/:id',
    accountController.getAddress
);

router.patch(
    '/addresses/:id/main',
    accountController.setMain
);

router.patch(
    '/addresses/:id',
    accountController.updateAddress
);

router.delete(
    '/addresses/:id',
    accountController.deactivateAddress
);

export default router;
