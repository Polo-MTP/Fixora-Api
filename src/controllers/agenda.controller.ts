import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app-error.ts';
import { createBlock, deleteBlock, getAgenda, updateBlock } from '../services/agenda.service.ts';

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

/** GET /api/agenda (API-45) */
export async function getAgendaController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAgenda(actorFromRequest(req), req.query);
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/agenda/blocks (API-45) */
export async function createBlockController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createBlock(actorFromRequest(req), req.body);
    return res.status(201).json({ success: true, message: 'Horario bloqueado.', data });
  } catch (error) {
    return next(error);
  }
}

/** PATCH /api/agenda/blocks/:id (API-45) */
export async function updateBlockController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updateBlock(actorFromRequest(req), req.params.id, req.body);
    return res.status(200).json({ success: true, message: 'Bloqueo actualizado.', data });
  } catch (error) {
    return next(error);
  }
}

/** DELETE /api/agenda/blocks/:id (API-45) */
export async function deleteBlockController(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteBlock(actorFromRequest(req), req.params.id);
    return res.status(200).json({ success: true, message: 'Bloqueo eliminado.' });
  } catch (error) {
    return next(error);
  }
}
