import type { Request, Response, NextFunction } from 'express';

import { AuthError, login, refreshSession, logout } from '../services/auth.service.ts';
import { deviceTokenService } from '../services/device-token.service.ts';

import {
  registerClient,
  verifyEmail,
  resendVerificationCode,
  type RegisterClientInput,
} from '../services/registration.service.ts';

function handleAuthError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof AuthError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  next(error);
}

export async function loginController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const { email, password } = body;

    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Debes proporcionar email y password como cadenas de texto no vacías.',
      });
      return;
    }

    const result = await login(email.trim().toLowerCase(), password);

    // Si la app móvil envía opcionalmente el token de dispositivo en el cuerpo del login
    const deviceToken = body.deviceToken ?? body.device_token;
    if (deviceToken && typeof deviceToken === 'string' && deviceToken.trim()) {
      const platform = (body.devicePlatform ??
        body.device_platform ??
        body.platform ??
        'android') as 'android' | 'ios' | 'web';
      try {
        await deviceTokenService.registerToken(result.user.id, {
          token: deviceToken.trim(),
          platform,
        });
      } catch (deviceError) {
        console.warn(
          '[auth.controller] No se pudo registrar el token del dispositivo:',
          deviceError,
        );
      }
    }

    res.status(200).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}

export async function refreshController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const { refreshToken } = body;

    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      res.status(400).json({
        error: 'REFRESH_TOKEN_REQUIRED',
        message: 'Debes proporcionar el token de renovación.',
      });
      return;
    }

    const result = await refreshSession(refreshToken.trim());

    res.status(200).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}

export async function logoutController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const { refreshToken } = body;

    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      res.status(400).json({
        error: 'REFRESH_TOKEN_REQUIRED',
        message: 'Debes proporcionar el token de renovación.',
      });
      return;
    }

    const result = await logout(refreshToken.trim());

    // Si la app móvil envía opcionalmente el token de dispositivo en el cuerpo del logout
    const deviceToken = body.deviceToken ?? body.device_token ?? body.token;
    if (deviceToken && typeof deviceToken === 'string' && deviceToken.trim()) {
      try {
        await deviceTokenService.deactivateTokenByValue(deviceToken.trim());
      } catch (deviceError) {
        console.warn(
          '[auth.controller] No se pudo desactivar el token del dispositivo:',
          deviceError,
        );
      }
    }

    res.status(200).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}

// ============================================================================
// REGISTRO DE CLIENTE
// ============================================================================

export async function registerClientController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};

    const input: RegisterClientInput = {
      email: body.email,
      password: body.password,
      name: body.name,
      lastname_p: body.lastname_p,
      lastname_m: body.lastname_m,
      birth_date: body.birth_date,
      phone: body.phone,
    };

    const result = await registerClient(input);

    res.status(201).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}

// ============================================================================
// VERIFICAR CORREO
// ============================================================================

export async function verifyEmailController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};

    const result = await verifyEmail(body.email, body.code);

    res.status(200).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}

// ============================================================================
// REENVIAR CÓDIGO
// ============================================================================

export async function resendVerificationController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};

    const result = await resendVerificationCode(body.email);

    res.status(200).json(result);
  } catch (error: unknown) {
    handleAuthError(error, res, next);
  }
}
