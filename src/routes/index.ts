import { Router } from 'express';
import { healthRouter } from './health.routes.ts';
import { userRouter } from './user.routes.ts';
import { storageRouter } from './storage.routes.ts';
import { supplierApplicationsRouter, documentTypesRouter } from './supplier-application.routes.ts';
import { deviceTokenRouter } from './device-token.routes.ts';
import { adminSupplierApplicationsRouter } from './admin-supplier-application.routes.ts';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/files', storageRouter);
apiRouter.use('/supplier-applications', supplierApplicationsRouter);
apiRouter.use('/document-types', documentTypesRouter);
apiRouter.use('/me/devices', deviceTokenRouter);
apiRouter.use('/admin', adminSupplierApplicationsRouter);
