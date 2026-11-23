import type { Request, Response, NextFunction } from 'express';

export function authorizeRoles(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'AUTHENTICATION_REQUIRED',
        message: 'Debes iniciar sesión para acceder a este recurso.',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: 'No tienes permisos para realizar esta acción.',
      });
      return;
    }

    next();
  };
}
