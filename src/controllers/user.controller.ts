import type { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service.ts';
import { BadRequestError } from '../errors/app-error.ts';

export class UserController {
  async getAll(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await userService.getAllUsers();
      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const idStr = Array.isArray(id) ? id[0] : id;

      if (!idStr || !/^\d+$/.test(idStr)) {
        throw new BadRequestError('El ID proporcionado debe ser un número entero válido');
      }

      const user = await userService.getUserById(BigInt(idStr));
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
