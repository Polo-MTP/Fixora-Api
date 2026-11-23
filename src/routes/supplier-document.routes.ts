import { Router } from 'express';
import { supplierDocumentVisibilityController } from '../controllers/supplier-document-visibility.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { handleUploadErrors } from '../middlewares/upload.middleware.ts';

const router = Router();

// Subir un certificado nuevo del proveedor aprobado (autenticado, multipart con el campo file)
router.post(
  '/',
  authenticateToken,
  handleUploadErrors,
  supplierDocumentVisibilityController.uploadCertificate,
);

// Mostrar u ocultar certificado en la ficha pública (autenticado)
router.patch(
  '/:id/visibility',
  authenticateToken,
  supplierDocumentVisibilityController.updateVisibility,
);

export default router;
