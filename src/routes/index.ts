import { Router } from 'express';
import { healthRouter } from './health.routes.ts';
import { userRouter } from './user.routes.ts';
import { storageRouter } from './storage.routes.ts';
import { supplierApplicationsRouter, documentTypesRouter } from './supplier-application.routes.ts';
import { deviceTokenRouter } from './device-token.routes.ts';
import { adminSupplierApplicationsRouter } from './admin-supplier-application.routes.ts';
import { adminIncomeRouter } from './admin-income.routes.ts';
import sanctionRouter from './sanction.routes.ts';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/files', storageRouter);
apiRouter.use('/supplier-applications', supplierApplicationsRouter);
apiRouter.use('/document-types', documentTypesRouter);
apiRouter.use('/me/devices', deviceTokenRouter);
apiRouter.use('/sanctions', sanctionRouter);
apiRouter.use('/admin', adminSupplierApplicationsRouter);
apiRouter.use('/admin', adminIncomeRouter);
