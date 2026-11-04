
import { Router } from 'express';

import {
    forgotPasswordController,
    resetPasswordController
} from '../controllers/password-recovery.controller.ts';

const router = Router();

// ============================================================
// API-9: RECUPERACIÓN DE CONTRASEÑA
// ============================================================

// Solicitar código de recuperación.
// Ruta pública, no requiere JWT.
router.post(
    '/forgot-password',
    forgotPasswordController
);

// Validar código y establecer nueva contraseña.
// Ruta pública, no requiere JWT.
router.post(
    '/reset-password',
    resetPasswordController
);

export default router;
