import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app-error.ts';
import { listProviderIncome } from '../services/provider-income.service.ts';

/** GET /api/income (API-46) */
export async function listProviderIncomeController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
    const data = await listProviderIncome({ id: req.user.id, role: req.user.role }, req.query);
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', ...data });
  } catch (error) {
    return next(error);
  }
}
