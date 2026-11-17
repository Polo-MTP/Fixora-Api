import { Router } from 'express';
import { deviceTokenController } from '../controllers/device-token.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

export const deviceTokenRouter = Router();

// Todas las rutas de gestión de dispositivos requieren autenticación
deviceTokenRouter.use(authenticateToken);

// Registrar o reasignar token de dispositivo
deviceTokenRouter.post('/', (req, res, next) =>
  deviceTokenController.registerDevice(req, res, next),
);

// Desactivar token por parámetro de URL (DELETE /api/me/devices/:token)
deviceTokenRouter.delete('/:token', (req, res, next) =>
  deviceTokenController.deactivateDevice(req, res, next),
);

// Desactivar token vía body (POST /api/me/devices/deactivate)
deviceTokenRouter.post('/deactivate', (req, res, next) =>
  deviceTokenController.deactivateDeviceBody(req, res, next),
);
