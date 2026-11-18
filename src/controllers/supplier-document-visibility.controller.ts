import type { Request, Response, NextFunction } from 'express';
import { supplierDocumentVisibilityService } from '../services/supplier-document-visibility.service.ts';
import { supplierCertificateService } from '../services/supplier-certificate.service.ts';
import { BadRequestError, UnauthorizedError } from '../errors/app-error.ts';

export class SupplierDocumentVisibilityController {
  /**
   * PATCH /api/supplier-documents/:id/visibility
   * Modifica la visibilidad pública o privada de un certificado de proveedor.
   */
  async updateVisibility(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError(
          'Debes iniciar sesión para modificar la visibilidad de tus documentos.',
        );
      }

      const documentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { is_public } = req.body ?? {};

      if (typeof is_public !== 'boolean') {
        throw new BadRequestError(
          'El campo is_public es obligatorio y debe ser un valor booleano.',
        );
      }

      const data = await supplierDocumentVisibilityService.updateDocumentVisibility(
        documentId,
        is_public,
        req.user,
      );

      res.status(200).json({
        success: true,
        message: is_public
          ? 'Certificado publicado exitosamente en tu ficha pública.'
          : 'Certificado ocultado de tu ficha pública.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/supplier-documents
   * El proveedor aprobado sube un certificado nuevo (multipart: file, y opcionales
   * type_document_id y due_date). Queda pendiente de revisión del administrador.
   */
  async uploadCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Debes iniciar sesión para subir certificados.');
      }
      const data = await supplierCertificateService.uploadCertificate(req.user, {
        file: req.file,
        typeDocumentId: req.body?.type_document_id,
        dueDate: req.body?.due_date,
      });
      res.status(201).json({
        success: true,
        message: 'Certificado recibido. Podrás mostrarlo en tu ficha cuando se apruebe.',
        data,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const supplierDocumentVisibilityController = new SupplierDocumentVisibilityController();
