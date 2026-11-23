import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  listPriceAdjustments,
  proposePriceAdjustment,
  respondPriceAdjustment,
} from '../services/price-adjustment.service.ts';

function parseId(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new AppError(`El identificador de ${label} no es válido.`, 400, 'INVALID_ID');
  }
  return BigInt(value);
}

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

export async function listPriceAdjustmentsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await listPriceAdjustments(
      parseId(req.params.id, 'solicitud'),
      actorFromRequest(req),
    );
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

export async function proposePriceAdjustmentController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await proposePriceAdjustment(
      parseId(req.params.id, 'solicitud'),
      actorFromRequest(req),
      req.body,
    );
    // 201 al crearlo; 200 si es el reintento de uno que ya existía (mismo client_uuid).
    return res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.created
        ? 'Ajuste enviado. El cliente debe aprobarlo.'
        : 'El ajuste ya estaba registrado.',
      data: result.adjustment,
    });
  } catch (error) {
    return next(error);
  }
}

function respondController(decision: 'aprobado' | 'rechazado') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await respondPriceAdjustment(
        parseId(req.params.id, 'solicitud'),
        parseId(req.params.adjustmentId, 'ajuste'),
        actorFromRequest(req),
        decision,
      );
      return res.status(200).json({
        success: true,
        message: decision === 'aprobado' ? 'Ajuste aprobado.' : 'Ajuste rechazado.',
        data,
      });
    } catch (error) {
      return next(error);
    }
  };
}

export const approvePriceAdjustmentController = respondController('aprobado');
export const rejectPriceAdjustmentController = respondController('rechazado');
