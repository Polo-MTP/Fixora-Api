import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { AuthError } from '../services/auth.service.ts';
import { AppError } from '../errors/app-error.ts';
import { ENV } from '../config/env.ts';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Errores propios del módulo de autenticación
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
      },
    });
    return;
  }

  // Errores de validación de Zod
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Los datos enviados no son válidos.',
        statusCode: 400,
        details: err.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  // Errores controlados de la API
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: 'APP_ERROR',
        message: err.message,
        statusCode: err.statusCode,
      },
    });
    return;
  }

  // Errores inesperados
  console.error('Error no controlado:', err);

  const isDevelopment = ENV.NODE_ENV === 'development';

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Ocurrió un error interno.',
      statusCode: 500,
      ...(isDevelopment && err instanceof Error ? { stack: err.stack } : {}),
    },
  });
}
