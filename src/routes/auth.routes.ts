import { Router } from 'express';

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
router.post('/login', loginController);

// Renovar los tokens de una sesión.
router.post('/refresh', refreshController);

// Cerrar sesión.
router.post('/logout', logoutController);

// ============================================================================
// REGISTRO DE CLIENTE
// ============================================================================

// Registrar un cliente.
router.post('/register', registerClientController);

// Verificar correo electrónico.
router.post('/verify-email', verifyEmailController);

// Reenviar código de verificación.
router.post('/resend-verification', resendVerificationController);

export default router;
