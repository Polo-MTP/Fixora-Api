import type { Request, Response, NextFunction } from 'express';
import { portfolioService } from '../services/portfolio.service.ts';
import { UnauthorizedError } from '../errors/app-error.ts';

export class PortfolioController {
  /**
   * GET /api/branches/:id/portfolio
   * Lista los trabajos publicados del portafolio de una sucursal (público).
   */
  async getBranchPortfolio(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await portfolioService.getBranchPortfolio(branchId);

      res.status(200).json({
        success: true,
        message: 'Trabajos del portafolio obtenidos exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/branches/:id/portfolio
   * Agrega un nuevo trabajo con fotos al portafolio de la sucursal.
   */
  async addWorkToPortfolio(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para agregar un trabajo al portafolio.');
      }

      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await portfolioService.addWorkToPortfolio(branchId, req.body, req.user);

      res.status(201).json({
        success: true,
        message: 'Trabajo agregado al portafolio exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/portfolio/:id
   * Quita un trabajo del portafolio.
   */
  async deletePortfolioWork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para eliminar este trabajo.');
      }

      const workId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await portfolioService.deletePortfolioWork(workId, req.user);

      res.status(200).json({
        success: true,
        message: 'Trabajo quitado del portafolio exitosamente.',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/branches/:id/categories
   * Reemplaza las categorías ofrecidas por una sucursal.
   */
  async updateBranchCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para actualizar las categorías.');
      }

      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await portfolioService.updateBranchCategories(branchId, req.body, req.user);

      res.status(200).json({
        success: true,
        message: 'Categorías de la sucursal actualizadas exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/branches/:id/certificates
   * Obtiene los certificados públicos aprobados de la sucursal.
   */
  async getBranchCertificates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await portfolioService.getBranchCertificates(branchId);

      res.status(200).json({
        success: true,
        message: 'Certificados públicos obtenidos exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const portfolioController = new PortfolioController();
