import { Router } from 'express';
import {
  loginController,
  refreshController,
  logoutController,
} from '../controllers/auth.controller.ts';

const router = Router();

// Iniciar sesión.
router.post('/login', loginController);

// Renovar los tokens de una sesión.
router.post('/refresh', refreshController);

// Cerrar la sesión.
router.post('/logout', logoutController);

export default router;
