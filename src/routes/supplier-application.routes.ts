import { Router, type Request, type Response, type NextFunction } from 'express';
import { supplierApplicationController } from '../controllers/supplier-application.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { multerSingleFile } from '../middlewares/upload.middleware.ts';

/**
 * Middleware que procesa multipart únicamente cuando el Content-Type es multipart/form-data,
 * permitiendo también peticiones en application/json sin error.
 */
function optionalUpload(req: Request, res: Response, next: NextFunction): void {
  if (req.is('multipart/form-data')) {
    multerSingleFile(req, res, (err: unknown) => {
      if (err) {
        return next(err);
      }
      next();
    });
  } else {
    next();
  }
}

export const supplierApplicationsRouter = Router();

// Consultar solicitud del proveedor autenticado
supplierApplicationsRouter.get('/me', authenticateToken, (req, res, next) =>
  supplierApplicationController.getMyApplication(req, res, next),
);

// Reemplazar documento para el proveedor autenticado en 'documentacion_incompleta'
supplierApplicationsRouter.put(
  '/me/documents/:typeDocumentId',
  authenticateToken,
  optionalUpload,
  (req, res, next) => supplierApplicationController.replaceDocumentMe(req, res, next),
);

// Reemplazar documento por ID de solicitud en 'documentacion_incompleta'
supplierApplicationsRouter.put(
  '/:id/documents/:typeDocumentId',
  authenticateToken,
  optionalUpload,
  (req, res, next) => supplierApplicationController.replaceDocumentById(req, res, next),
);

// API-43: ya no hay consultas públicas por id o por correo (/status y /:id). Regresaban el RFC,
// el correo y el nombre del encargado de cualquier proveedor sin iniciar sesión, con ids
// consecutivos. El proveedor ve la suya en GET /me y el Administrador en /api/admin.

// Enviar solicitud de registro de proveedor (Asistente web de registro)
supplierApplicationsRouter.post('/', optionalUpload, (req, res, next) =>
  supplierApplicationController.submitApplication(req, res, next),
);

export const documentTypesRouter = Router();

// Catálogo de tipos de documento requeridos para el asistente de registro
documentTypesRouter.get('/', (req, res, next) =>
  supplierApplicationController.getDocumentTypes(req, res, next),
);
