import { Router } from 'express';

import { authAccountRateLimit, authIpRateLimit } from '../middlewares/rate-limit.middleware.ts';
import {
  forgotPasswordController,
  resetPasswordController,
} from '../controllers/password-recovery.controller.ts';

const router = Router();

// ============================================================
// API-9: RECUPERACIÓN DE CONTRASEÑA
// ============================================================

// Solicitar código de recuperación.
// Ruta pública, no requiere JWT.
router.post('/forgot-password', authIpRateLimit, authAccountRateLimit, forgotPasswordController);

// Validar código y establecer nueva contraseña.
// Ruta pública, no requiere JWT.
router.post('/reset-password', authIpRateLimit, authAccountRateLimit, resetPasswordController);

export default router;
