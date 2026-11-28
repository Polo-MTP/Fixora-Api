import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
  addComment,
  addEvidence,
  assignReport,
  changeReportStatus,
  createReport,
  getReport,
  listReports,
} from '../services/report.service.ts';

function parseId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new AppError('El identificador del reporte no es válido.', 400, 'INVALID_ID');
  }
  return BigInt(value);
}

function actorFromRequest(req: Request) {
  if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
  return { id: req.user.id, role: req.user.role };
}

const OK_MESSAGE = 'Operación realizada correctamente.';

export async function createReportController(req: Request, res: Response, next: NextFunction) {
  try {
    const { report, created } = await createReport(actorFromRequest(req), req.body);
    // 201 al crear; 200 cuando el client_uuid ya existía y se devuelve el reporte original.
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? `Reporte ${report.folio} creado correctamente.`
        : 'El reporte ya había sido creado.',
      data: report,
    });
  } catch (error) {
    return next(error);
  }
}

export async function listReportsController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listReports(actorFromRequest(req), req.query);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function getReportController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getReport(parseId(req.params.id), actorFromRequest(req));
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function addReportCommentController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await addComment(parseId(req.params.id), actorFromRequest(req), req.body);
    return res
      .status(201)
      .json({ success: true, message: 'Comentario agregado a la bitácora.', data });
  } catch (error) {
    return next(error);
  }
}

export async function addReportEvidenceController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await addEvidence(parseId(req.params.id), actorFromRequest(req), req.body);
    return res.status(201).json({ success: true, message: 'Evidencia agregada.', data });
  } catch (error) {
    return next(error);
  }
}

export async function changeReportStatusController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await changeReportStatus(parseId(req.params.id), actorFromRequest(req), req.body);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}

export async function assignReportController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await assignReport(parseId(req.params.id), actorFromRequest(req), req.body);
    return res.status(200).json({ success: true, message: OK_MESSAGE, data });
  } catch (error) {
    return next(error);
  }
}
