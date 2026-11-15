import { Router } from 'express';

import * as accountController from '../controllers/account.controller.ts';

import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { notificationsController } from '../controllers/notifications.controller.ts';

const router = Router();

// Se monta en /api/me (ver app.ts), como dice el contrato.
// Todas las rutas de este módulo requieren autenticación.
router.use(authenticateToken);

// ============================================================
// CENTRO DE NOTIFICACIONES (API-25)
// ============================================================

router.get('/notifications', (req, res, next) => notificationsController.list(req, res, next));
router.post('/notifications/read-all', (req, res, next) =>
    notificationsController.markAllAsRead(req, res, next),
);
router.post('/notifications/:id/read', (req, res, next) =>
    notificationsController.markAsRead(req, res, next),
);

// ============================================================
// DATOS PERSONALES
// ============================================================

router.get('/', accountController.getMe);

router.patch('/', accountController.updateMe);

router.patch('/password', accountController.changePassword);

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
