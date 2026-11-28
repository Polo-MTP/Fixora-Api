import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import { getServiceTimeline } from '../services/service-timeline.service.ts';
import { assignFromInbox, listInbox, resolveFromInbox } from '../services/support-inbox.service.ts';

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

const OK_MESSAGE = 'Operación realizada correctamente.';

export async function listInboxController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listInbox(actorFromRequest(req), req.query);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function assignInboxController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await assignFromInbox(actorFromRequest(req), req.params.id, req.body);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function resolveInboxController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await resolveFromInbox(actorFromRequest(req), req.params.id, req.body);
    return res.status(200).json({ success: true, message: 'Reporte resuelto.', data });
  } catch (error) {
    return next(error);
  }
}

export async function serviceTimelineController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getServiceTimeline(actorFromRequest(req), req.params.id, req.query);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}
