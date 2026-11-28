import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app-error.ts';
import { getProviderStats } from '../services/provider-stats.service.ts';

/** GET /api/stats (API-44) */
export async function getProviderStatsController(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
    const data = await getProviderStats({ id: req.user.id, role: req.user.role }, req.query);
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}
