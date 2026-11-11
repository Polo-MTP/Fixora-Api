import type { Request, Response, NextFunction } from 'express';
import { employeeProfileService } from '../services/employee-profile.service.ts';
import { UnauthorizedError } from '../errors/app-error.ts';

export class EmployeeProfileController {
  /**
   * GET /api/employees/:id/profile
   * Obtiene el perfil detallado del empleado con foto, biografía y vehículo.
   */
  async getEmployeeDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para consultar el perfil del empleado.');
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await employeeProfileService.getEmployeeDetail(employeeId, req.user);

      res.status(200).json({
        success: true,
        message: 'Perfil de empleado obtenido exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/employees/:id/profile
   * Actualiza la foto y biografía del empleado.
   */
  async updateEmployeeProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para actualizar el perfil del empleado.');
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await employeeProfileService.updateEmployeeProfile(
        employeeId,
        req.body,
        req.user,
      );

      res.status(200).json({
        success: true,
        message: 'Foto y biografía del empleado actualizadas exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/employees/:id/vehicle
   * Obtiene el vehículo activo asignado al empleado.
   */
  async getEmployeeVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError(
          'Debes iniciar sesión para consultar el vehículo del empleado.',
        );
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await employeeProfileService.getEmployeeVehicle(employeeId, req.user);

      res.status(200).json({
        success: true,
        message: data
          ? 'Vehículo del empleado obtenido exitosamente.'
          : 'El empleado no tiene un vehículo registrado.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/employees/:id/vehicle
   * Registra o actualiza el vehículo asignado al empleado.
   */
  async updateEmployeeVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError(
          'Debes iniciar sesión para registrar el vehículo del empleado.',
        );
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await employeeProfileService.updateEmployeeVehicle(
        employeeId,
        req.body,
        req.user,
      );

      res.status(200).json({
        success: true,
        message: 'Vehículo del empleado registrado exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/employees/:id/vehicle
   * Desactiva el vehículo asignado al empleado.
   */
  async deleteEmployeeVehicle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para desactivar el vehículo.');
      }

      const employeeId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await employeeProfileService.deleteEmployeeVehicle(employeeId, req.user);

      res.status(200).json({
        success: true,
        message: 'Vehículo del empleado desactivado exitosamente.',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/branches/:id/employees
   * Lista todos los empleados de la sucursal con su foto, biografía y vehículo.
   */
  async getBranchEmployees(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError(
          'Debes iniciar sesión para consultar los empleados de la sucursal.',
        );
      }

      const branchId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const data = await employeeProfileService.getBranchEmployees(branchId, req.user);

      res.status(200).json({
        success: true,
        message: 'Empleados de la sucursal obtenidos exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/me/employee-profile
   * Acceso directo para que un empleado o gerente consulte su propia ficha.
   */
  async getMyEmployeeProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión.');
      }

      const data = await employeeProfileService.getMyEmployeeProfile(req.user);

      res.status(200).json({
        success: true,
        message: 'Tu perfil de empleado ha sido obtenido exitosamente.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const employeeProfileController = new EmployeeProfileController();
