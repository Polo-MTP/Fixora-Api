import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  applySanction,
  getSanction,
  liftSanction,
  listMySanctions,
  listSanctions,
} from '../services/sanction.service.ts';

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

const OK_MESSAGE = 'Operación realizada correctamente.';

export async function applySanctionController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await applySanction(actorFromRequest(req), req.body);
    return res.status(201).json({ success: true, message: 'Sanción aplicada.', data });
  } catch (error) {
    return next(error);
  }
}

export async function listSanctionsController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listSanctions(actorFromRequest(req), req.query);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function listMySanctionsController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listMySanctions(actorFromRequest(req));
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function getSanctionController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getSanction(actorFromRequest(req), req.params.id);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function liftSanctionController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await liftSanction(actorFromRequest(req), req.params.id, req.body);
    return res.status(200).json({ success: true, message: 'Sanción retirada.', data });
  } catch (error) {
    return next(error);
  }
}
