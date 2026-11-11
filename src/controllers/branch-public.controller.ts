import type { Request, Response, NextFunction } from 'express';
import { branchPublicService } from '../services/branch-public.service.ts';

export class BranchPublicController {
  /**
   * GET /api/branches/:id/public
   * Obtiene la ficha pública completa de una sucursal (Ticket API-21).
   */
  async getBranchPublicProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await branchPublicService.getBranchPublicProfile(branchId);

      res.status(200).json({
        success: true,
        message: 'Ficha pública de la sucursal obtenida exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const branchPublicController = new BranchPublicController();
