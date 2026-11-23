import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  listMyDebts,
  listMyPayments,
  listRequestPayments,
  registerPayment,
  respondPayment,
} from '../services/payment.service.ts';

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

export async function listRequestPaymentsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await listRequestPayments(
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

export async function registerPaymentController(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await registerPayment(
      parseId(req.params.id, 'solicitud'),
      actorFromRequest(req),
      req.body,
    );
    // 201 al crearlo; 200 si es el reintento de uno que ya existía (mismo client_uuid).
    return res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.created
        ? 'Pago registrado. El proveedor debe confirmar que lo recibió.'
        : 'El pago ya estaba registrado.',
      data: result.payment,
    });
  } catch (error) {
    return next(error);
  }
}

function respondController(decision: 'completado' | 'fallido') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await respondPayment(
        parseId(req.params.id, 'solicitud'),
        parseId(req.params.paymentId, 'pago'),
        actorFromRequest(req),
        decision,
        req.body,
      );
      return res.status(200).json({
        success: true,
        message: decision === 'completado' ? 'Pago confirmado.' : 'Pago marcado como no recibido.',
        data,
      });
    } catch (error) {
      return next(error);
    }
  };
}

export const confirmPaymentController = respondController('completado');
export const rejectPaymentController = respondController('fallido');

export async function listMyPaymentsController(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await listMyPayments(actorFromRequest(req), {
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.status(200).json({
      success: true,
      message: 'Operación realizada correctamente.',
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return next(error);
  }
}

export async function listMyDebtsController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listMyDebts(actorFromRequest(req));
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}
