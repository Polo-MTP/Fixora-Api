import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  getCommissionSettings,
  listIncome,
  markCommissionPaid,
  setCommissionPercentage,
} from '../services/admin-income.service.ts';

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

export async function listIncomeController(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await listIncome({
      branch_id: req.query.branch_id,
      commission_status: req.query.commission_status,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.status(200).json({
      success: true,
      message: 'Operación realizada correctamente.',
      data: result.data,
      totals: result.totals,
      pagination: result.pagination,
    });
  } catch (error) {
    return next(error);
  }
}

export async function markCommissionPaidController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[1-9]\d{0,17}$/.test(id)) {
      throw new AppError('El identificador del ingreso no es válido.', 400, 'INVALID_ID');
    }
    const data = await markCommissionPaid(BigInt(id));
    return res.status(200).json({ success: true, message: 'Comisión marcada como pagada.', data });
  } catch (error) {
    return next(error);
  }
}

export async function getCommissionSettingsController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await getCommissionSettings();
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

export async function setCommissionPercentageController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await setCommissionPercentage(actorFromRequest(req), req.body);
    return res
      .status(201)
      .json({ success: true, message: 'Porcentaje de comisión actualizado.', data });
  } catch (error) {
    return next(error);
  }
}
