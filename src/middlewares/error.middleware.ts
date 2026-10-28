import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import { ENV } from '../config/env.ts';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404));
}

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message = err.message || 'Error interno del servidor';

  if (statusCode === 500) {
    console.error('Unhandled Server Error:', err);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      statusCode,
      ...(ENV.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    },
  });
}
