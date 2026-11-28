import type { NextFunction, Request, Response } from 'express';

import { getAdminDashboard } from '../services/admin-dashboard.service.ts';

/** GET /api/admin/dashboard (API-52) */
export async function getAdminDashboardController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAdminDashboard(req.query);
    return res
      .status(200)
      .json({ success: true, message: 'Operación realizada correctamente.', data });
  } catch (error) {
    return next(error);
  }
}
