import type { Request, Response, NextFunction } from 'express';
import {
  advanceServiceRequestStatus,
  getServiceRequest,
  getServiceRequestEvents,
  listServiceRequests,
} from '../services/service-request-status.service.ts';
import { AppError } from '../errors/app-error.ts';
import {
  acceptServiceRequest,
  rejectServiceRequest,
} from '../services/service-request-response.service.ts';
import { cancelServiceRequest } from '../services/service-request-cancellation.service.ts';

function parseId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new AppError('El identificador de solicitud no es válido.', 400, 'INVALID_ID');
  }
  return BigInt(value);
}

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

export async function listMyServiceRequests(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await listServiceRequests(actorFromRequest(req), {
      status: req.query.status,
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

export async function getOneServiceRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getServiceRequest(parseId(req.params.id), actorFromRequest(req));
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

export async function changeServiceRequestStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await advanceServiceRequestStatus(
      parseId(req.params.id),
      actorFromRequest(req),
      req.body,
    );
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

export async function listServiceRequestEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getServiceRequestEvents(parseId(req.params.id), actorFromRequest(req));
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

export async function acceptServiceRequestController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await acceptServiceRequest(
      parseId(req.params.id),
      actorFromRequest(req),
      req.body,
    );
    return res.status(200).json({
      success: true,
      message: 'Solicitud aceptada correctamente.',
      data,
    });
  } catch (error) {
    return next(error);
  }
}

export async function rejectServiceRequestController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await rejectServiceRequest(parseId(req.params.id), actorFromRequest(req), req.body);
    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}


export async function cancelServiceRequestController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await cancelServiceRequest(
      parseId(req.params.id),
      actorFromRequest(req),
      req.body,
    );
    return res.status(200).json({
      success: true,
      message: 'Solicitud cancelada correctamente.',
      data,
    });
  } catch (error) {
    return next(error);
  }
}
