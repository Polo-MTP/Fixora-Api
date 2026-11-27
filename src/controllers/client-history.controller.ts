import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  getActiveClientService,
  getClientService,
  listClientServices,
} from '../services/client-history.service.ts';

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

const OK_MESSAGE = 'Operación realizada correctamente.';

export async function listClientServicesController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { items, pagination } = await listClientServices(actorFromRequest(req), req.query);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data: items, pagination });
  } catch (error) {
    return next(error);
  }
}

export async function activeClientServiceController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await getActiveClientService(actorFromRequest(req));
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function getClientServiceController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getClientService(actorFromRequest(req), req.params.id);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}
