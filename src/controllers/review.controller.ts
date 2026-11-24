import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  createReview,
  getPublicBranchReviews,
  getRequestReviews,
} from '../services/review.service.ts';

function parseId(value: unknown, message: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new AppError(message, 400, 'INVALID_ID');
  }
  return BigInt(value);
}

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

export async function createReviewController(req: Request, res: Response, next: NextFunction) {
  try {
    const { review, created } = await createReview(
      parseId(req.params.id, 'El identificador de solicitud no es válido.'),
      actorFromRequest(req),
      req.body,
    );
    // 201 al crear; 200 cuando el client_uuid ya existía y se devuelve la reseña original.
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Reseña guardada correctamente.' : 'La reseña ya había sido guardada.',
      data: review,
    });
  } catch (error) {
    return next(error);
  }
}

export async function getRequestReviewsController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getRequestReviews(
      parseId(req.params.id, 'El identificador de solicitud no es válido.'),
      actorFromRequest(req),
    );
    return res.status(200).json({
      success: true,
      message: 'Operación realizada correctamente.',
      data,
    });
  } catch (error) {
    return next(error);
  }
}

/** Público: no requiere sesión. */
export async function listBranchReviewsController(req: Request, res: Response, next: NextFunction) {
  try {
    const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const data = await getPublicBranchReviews(branchId, req.query);
    return res.status(200).json({
      success: true,
      message: 'Reseñas de la sucursal obtenidas exitosamente.',
      data,
    });
  } catch (error) {
    return next(error);
  }
}
