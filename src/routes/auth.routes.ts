import { Router } from 'express';

import { authAccountRateLimit, authIpRateLimit } from '../middlewares/rate-limit.middleware.ts';
import {
  loginController,
  refreshController,
  logoutController,
  registerClientController,
  verifyEmailController,
  resendVerificationController,
} from '../controllers/auth.controller.ts';

const router = Router();

// ============================================================================
// AUTENTICACIÓN
// ============================================================================

// Iniciar sesión.
router.post('/login', authIpRateLimit, authAccountRateLimit, loginController);

// Renovar los tokens de una sesión.
router.post('/refresh', refreshController);

// Cerrar sesión.
router.post('/logout', logoutController);

// ============================================================================
// REGISTRO DE CLIENTE
// ============================================================================

// Registrar un cliente.
router.post('/register', authIpRateLimit, authAccountRateLimit, registerClientController);

// Verificar correo electrónico.
router.post('/verify-email', authIpRateLimit, authAccountRateLimit, verifyEmailController);

// Reenviar código de verificación.
router.post(
  '/resend-verification',
  authIpRateLimit,
  authAccountRateLimit,
  resendVerificationController,
);

export default router;
