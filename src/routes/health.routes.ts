import { Router } from 'express';
import { healthController } from '../controllers/health.controller.ts';

export const healthRouter = Router();

healthRouter.get('/', (req, res, next) => healthController.check(req, res, next));
