import { Router } from 'express';
import { adminSupplierApplicationController } from '../controllers/admin-supplier-application.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

export const adminSupplierApplicationsRouter = Router();

// Todos los endpoints administrativos de revisión requieren un administrador autenticado.
adminSupplierApplicationsRouter.use(authenticateToken, authorizeRoles('administrador'));

adminSupplierApplicationsRouter.get('/supplier-applications', (req, res, next) =>
    adminSupplierApplicationController.list(req, res, next),
);

adminSupplierApplicationsRouter.get('/supplier-applications/:id', (req, res, next) =>
    adminSupplierApplicationController.getById(req, res, next),
);

adminSupplierApplicationsRouter.post('/supplier-applications/:id/resolution', (req, res, next) =>
    adminSupplierApplicationController.resolve(req, res, next),
);

adminSupplierApplicationsRouter.patch('/supplier-documents/:id', (req, res, next) =>
    adminSupplierApplicationController.reviewDocument(req, res, next),
);
