import type { Request, Response, NextFunction } from 'express';
import { deviceTokenService } from '../services/device-token.service.ts';
import { UnauthorizedError } from '../errors/app-error.ts';

export class DeviceTokenController {
  /**
   * POST /api/me/devices
   * Registra o reasigna un token de dispositivo para el usuario autenticado.
   */
  async registerDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para registrar tu dispositivo.');
      }

      const { token, platform } = req.body ?? {};
      const result = await deviceTokenService.registerToken(req.user.id, {
        token,
        platform,
      });

      res.status(201).json({
        success: true,
        message: 'Token de dispositivo registrado exitosamente.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/me/devices/:token
   * Desactiva un token de dispositivo para el usuario autenticado al cerrar sesión.
   */
  async deactivateDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para desactivar tu dispositivo.');
      }

      const tokenParam = req.params.token;
      const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
      const result = await deviceTokenService.deactivateToken(req.user.id, token);

      res.status(200).json({
        success: true,
        message: 'Token de dispositivo desactivado exitosamente.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/me/devices/deactivate
   * Alternativa por body para clientes o frameworks que no admiten DELETE con path parameters largos.
   */
  async deactivateDeviceBody(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para desactivar tu dispositivo.');
      }

      const { token } = req.body ?? {};
      const result = await deviceTokenService.deactivateToken(req.user.id, token);

      res.status(200).json({
        success: true,
        message: 'Token de dispositivo desactivado exitosamente.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const deviceTokenController = new DeviceTokenController();
