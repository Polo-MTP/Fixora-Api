import { Router } from 'express';
import { supplierDocumentVisibilityController } from '../controllers/supplier-document-visibility.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// Mostrar u ocultar certificado en la ficha pública (autenticado)
router.patch(
  '/:id/visibility',
  authenticateToken,
  supplierDocumentVisibilityController.updateVisibility,
);

export default router;
