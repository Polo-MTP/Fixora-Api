import { Router } from 'express';
import { userController } from '../controllers/user.controller.ts';

export const userRouter = Router();

userRouter.get('/', (req, res, next) => userController.getAll(req, res, next));
userRouter.get('/:id', (req, res, next) => userController.getById(req, res, next));
