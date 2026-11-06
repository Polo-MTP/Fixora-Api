import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { AuthError } from '../services/auth.service.ts';
import { AppError } from '../errors/app-error.ts';
import { ENV } from '../config/env.ts';

// Todas las respuestas de error usan el mismo formato del contrato (docs/openapi.yaml):
// { error: 'CODIGO', message: 'Texto legible', details?: [...] }

interface BodyParserError extends Error {
  type?: string;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(`Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'),
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Errores propios del módulo de autenticación
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  // Errores de validación de Zod
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Los datos enviados no son válidos.',
      details: err.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  // Errores controlados de la API
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  // Cuerpo que express.json() no pudo leer: es un error del cliente, no del servidor.
  const bodyError = err as BodyParserError;

  if (bodyError?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: 'INVALID_JSON',
      message: 'El cuerpo de la solicitud no es un JSON válido.',
    });
    return;
  }

  if (bodyError?.type === 'entity.too.large') {
    res.status(413).json({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'El cuerpo de la solicitud es demasiado grande.',
    });
    return;
  }

  // Errores inesperados
  console.error('Error no controlado:', err);

  const isDevelopment = ENV.NODE_ENV === 'development';

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'Ocurrió un error interno.',
    ...(isDevelopment && err instanceof Error ? { stack: err.stack } : {}),
  });
}
