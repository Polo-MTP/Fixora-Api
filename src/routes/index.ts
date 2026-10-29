import { Router } from 'express';
import { healthRouter } from './health.routes.ts';
import { userRouter } from './user.routes.ts';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/users', userRouter);
