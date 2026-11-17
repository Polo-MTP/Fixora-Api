import type { Request, Response, NextFunction } from 'express';
import { technicianAvailabilityService } from '../services/technician-availability.service.ts';
import { BadRequestError, UnauthorizedError } from '../errors/app-error.ts';

export class TechnicianAvailabilityController {
  /**
   * GET /api/technicians/me/availability
   * Consulta la disponibilidad y última posición del técnico autenticado.
   */
  async getMyAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para consultar tu disponibilidad.');
      }

      const data = await technicianAvailabilityService.getMyAvailability(req.user);

      res.status(200).json({
        success: true,
        message: 'Disponibilidad de técnico obtenida exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/technicians/me/availability
   * Cambia el estado En línea / Fuera de línea y actualiza la posición geográfica en Redis.
   */
  async updateMyAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para modificar tu disponibilidad.');
      }

      const { online, latitude, longitude } = req.body ?? {};

      if (typeof online !== 'boolean') {
        throw new BadRequestError('El campo online es obligatorio y debe ser un valor booleano.');
      }

      const data = await technicianAvailabilityService.updateMyAvailability(req.user, {
        online,
        latitude: typeof latitude === 'number' ? latitude : undefined,
        longitude: typeof longitude === 'number' ? longitude : undefined,
      });

      res.status(200).json({
        success: true,
        message: online
          ? 'Has cambiado tu estado a En línea exitosamente.'
          : 'Has cambiado tu estado a Fuera de línea.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/employees/:id/availability
   * Consulta la disponibilidad de un empleado específico.
   */
  async getEmployeeAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión.');
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await technicianAvailabilityService.getTechnicianAvailability(employeeId);

      res.status(200).json({
        success: true,
        message: 'Disponibilidad del empleado obtenida exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/employees/:id/availability
   * Modifica la disponibilidad de un empleado específico.
   */
  async updateEmployeeAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión.');
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { online, latitude, longitude } = req.body ?? {};

      if (typeof online !== 'boolean') {
        throw new BadRequestError('El campo online es obligatorio y debe ser un valor booleano.');
      }

      const data = await technicianAvailabilityService.updateTechnicianAvailability(employeeId, {
        online,
        latitude: typeof latitude === 'number' ? latitude : undefined,
        longitude: typeof longitude === 'number' ? longitude : undefined,
      });

      res.status(200).json({
        success: true,
        message: 'Disponibilidad actualizada exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const technicianAvailabilityController = new TechnicianAvailabilityController();
