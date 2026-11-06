import { Router } from 'express';
import { userController } from '../controllers/user.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

export const userRouter = Router();

// Solo el administrador puede consultar cuentas de otros usuarios.
userRouter.use(authenticateToken, authorizeRoles('administrador'));

userRouter.get('/', (req, res, next) => userController.getAll(req, res, next));
userRouter.get('/:id', (req, res, next) => userController.getById(req, res, next));
