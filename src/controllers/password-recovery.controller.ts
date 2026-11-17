import type { Request, Response, NextFunction } from 'express';

import {
  PasswordRecoveryError,
  requestPasswordRecovery,
  resetPassword,
} from '../services/password-recovery.service.ts';

// ============================================================
// MANEJO DE ERRORES
// ============================================================

function handleRecoveryError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof PasswordRecoveryError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });

    return;
  }

  next(error);
}

// ============================================================
// SOLICITAR RECUPERACIÓN
// POST /api/auth/forgot-password
// ============================================================

export async function forgotPasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};

    const { email } = body;

    if (typeof email !== 'string' || !email.trim()) {
      res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Debes proporcionar un correo electrónico.',
      });

      return;
    }

    const result = await requestPasswordRecovery(email.trim().toLowerCase());

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error: unknown) {
    handleRecoveryError(error, res, next);
  }
}

// ============================================================
// RESTABLECER CONTRASEÑA
// POST /api/auth/reset-password
// ============================================================

export async function resetPasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};

    const {
      email,
      code,
      newPassword,
      new_password,
    } = body;

    // Aceptar camelCase y snake_case.
    const password = newPassword ?? new_password;

    if (
      typeof email !== 'string' ||
      !email.trim() ||
      typeof code !== 'string' ||
      typeof password !== 'string'
    ) {
      res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Debes proporcionar correo, código y nueva contraseña.',
      });

      return;
    }

    const result = await resetPassword(
      email.trim().toLowerCase(),
      code,
      password,
    );

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error: unknown) {
    handleRecoveryError(error, res, next);
  }
}

