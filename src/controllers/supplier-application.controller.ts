import type { Request, Response, NextFunction } from 'express';
import { supplierApplicationService } from '../services/supplier-application.service.ts';
import { adminSupplierApplicationService } from '../services/admin-supplier-application.service.ts';
import { BadRequestError, UnauthorizedError } from '../errors/app-error.ts';
import type { CreateSupplierApplicationInput } from '../types/supplier-application.types.ts';

export class SupplierApplicationController {
  /**
   * Catálogo de tipos de documento requeridos para el asistente web
   * GET /api/document-types?supplier_type=independiente|empresa
   */
  async getDocumentTypes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const supplierType = req.query.supplier_type as
        'independiente' | 'empresa' | 'ambos' | undefined;

      const docs = await supplierApplicationService.getDocumentTypes(supplierType);
      res.status(200).json({ data: docs });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Envía la solicitud completa del asistente web de registro
   * POST /api/supplier-applications
   */
  async submitApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      let payload: CreateSupplierApplicationInput;

      // Soportar multipart/form-data con campo 'data' en JSON
      if (req.body?.data) {
        if (typeof req.body.data === 'string') {
          try {
            payload = JSON.parse(req.body.data);
          } catch {
            throw new BadRequestError(
              "El campo 'data' no contiene una estructura JSON válida.",
              'INVALID_JSON',
            );
          }
        } else {
          payload = req.body.data;
        }
      } else {
        payload = req.body;
      }

      if (!payload || typeof payload !== 'object') {
        throw new BadRequestError('El cuerpo de la solicitud no puede estar vacío.');
      }

      const result = await supplierApplicationService.createApplication(payload);

      res.status(201).json({
        data: result,
        message: 'Solicitud de proveedor recibida exitosamente.',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Consulta el estado de una solicitud (por email o applicationId)
   * GET /api/supplier-applications/status?email=... ó ?application_id=...
   */
  async getApplicationStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const applicationId = req.query.application_id as string | undefined;
      const email = req.query.email as string | undefined;

      const status = await supplierApplicationService.getApplicationStatus({
        applicationId,
        email,
      });

      res.status(200).json({ data: status });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Consulta la solicitud del proveedor autenticado
   * GET /api/supplier-applications/me
   */
  async getMyApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para consultar tu solicitud.');
      }

      const status = await adminSupplierApplicationService.getMyApplication(req.user.id);
      res.status(200).json({
        success: true,
        message: 'Operación realizada correctamente.',
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Consulta el estado de una solicitud por su ID en la URL
   * GET /api/supplier-applications/:id
   */
  async getApplicationById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idParam = req.params.id;
      const applicationId = Array.isArray(idParam) ? idParam[0] : idParam;
      const status = await supplierApplicationService.getApplicationStatus({
        applicationId,
      });

      res.status(200).json({ data: status });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reemplazar un documento para el proveedor autenticado cuando está en 'documentacion_incompleta'
   * PUT /api/supplier-applications/me/documents/:typeDocumentId
   */
  async replaceDocumentMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para reemplazar documentos.');
      }

      const typeDocParam = req.params.typeDocumentId;
      const typeDocumentId = Array.isArray(typeDocParam) ? typeDocParam[0] : typeDocParam;

      const result = await supplierApplicationService.replaceDocument({
        userId: req.user.id,
        typeDocumentId,
        dueDate: req.body?.due_date,
        fileKey: req.body?.file_key,
        file: req.file,
      });

      res.status(200).json({
        data: result.document,
        application_state: result.application_state,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reemplazar un documento por ID de solicitud cuando está en 'documentacion_incompleta'
   * PUT /api/supplier-applications/:id/documents/:typeDocumentId
   */
  async replaceDocumentById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para reemplazar documentos.');
      }

      const idParam = req.params.id;
      const applicationId = Array.isArray(idParam) ? idParam[0] : idParam;

      const typeDocParam = req.params.typeDocumentId;
      const typeDocumentId = Array.isArray(typeDocParam) ? typeDocParam[0] : typeDocParam;

      const result = await supplierApplicationService.replaceDocument({
        applicationId,
        userId: req.user.id,
        typeDocumentId,
        dueDate: req.body?.due_date,
        fileKey: req.body?.file_key,
        file: req.file,
      });

      res.status(200).json({
        data: result.document,
        application_state: result.application_state,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const supplierApplicationController = new SupplierApplicationController();
