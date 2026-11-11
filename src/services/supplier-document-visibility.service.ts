import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  branches,
  business,
  business_supplier,
  document_validations,
  employees,
  supplier_documents,
  suppliers,
  type_documents,
} from '../database/schema/tables.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import { storageService } from './storage.service.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import type { SupplierDocumentResponse } from '../types/portfolio.types.ts';

export const NON_PUBLISHABLE_DOC_PATTERN =
  /identificaci[oó]n|ine|pasaporte|domicilio|comprobante|situaci[oó]n fiscal|rfc|acta\s+constitutiva|poder\s+notarial|penales/i;

export class SupplierDocumentVisibilityService {
  /**
   * Cambia la visibilidad pública o privada de un certificado de proveedor.
   * Reglas de negocio críticas (Ticket API-20):
   * 1. Solo documentos con validación 'aprobado' pueden hacerse públicos.
   * 2. Los documentos de identidad, domicilio o fiscales NUNCA son públicos (retorna 409 DOCUMENT_NOT_PUBLISHABLE).
   */
  async updateDocumentVisibility(
    documentIdInput: string | bigint,
    isPublic: boolean,
    user: AuthenticatedUser,
  ): Promise<SupplierDocumentResponse> {
    const documentId = BigInt(documentIdInput);

    // 1. Obtener documento y su tipo
    const [docRow] = await db
      .select({
        id: supplier_documents.UniqueID,
        supplier_id: supplier_documents.supplier_id,
        type_document_id: supplier_documents.type_document_id,
        type_name: type_documents.name,
        file_key: supplier_documents.file_key,
        upload_date: supplier_documents.upload_date,
        due_date: supplier_documents.due_date,
        is_public: supplier_documents.is_public,
      })
      .from(supplier_documents)
      .innerJoin(type_documents, eq(supplier_documents.type_document_id, type_documents.UniqueID))
      .where(eq(supplier_documents.UniqueID, documentId))
      .limit(1);

    if (!docRow) {
      throw new NotFoundError('Documento de proveedor no encontrado.');
    }

    // 2. Validar propiedad y autorización del usuario
    await this.checkDocumentAccess(docRow.supplier_id, user);

    // 3. Reglas de publicación si se desea hacer público (is_public: true)
    if (isPublic) {
      // Regla A: No permitir publicación de documentos de identidad, domicilio o fiscales
      if (NON_PUBLISHABLE_DOC_PATTERN.test(docRow.type_name)) {
        throw new AppError(
          `El documento '${docRow.type_name}' no se puede publicar porque contiene datos confidenciales o personales.`,
          409,
          'DOCUMENT_NOT_PUBLISHABLE',
        );
      }

      // Regla B: Solo documentos con dictamen 'aprobado' pueden publicarse
      const [latestValidation] = await db
        .select({
          result: document_validations.result,
        })
        .from(document_validations)
        .where(eq(document_validations.document_id, documentId))
        .orderBy(desc(document_validations.reviewed_at))
        .limit(1);

      if (!latestValidation || latestValidation.result.toLowerCase() !== 'aprobado') {
        throw new AppError(
          'Solo se pueden publicar certificados o documentos que hayan sido aprobados por el administrador.',
          409,
          'DOCUMENT_NOT_PUBLISHABLE',
        );
      }
    }

    // 4. Actualizar estado de visibilidad
    await db
      .update(supplier_documents)
      .set({ is_public: isPublic })
      .where(eq(supplier_documents.UniqueID, documentId));

    // 5. Consultar última validación para armar la respuesta completa
    const [validation] = await db
      .select({
        result: document_validations.result,
        comment: document_validations.comment,
        reviewed_at: document_validations.reviewed_at,
      })
      .from(document_validations)
      .where(eq(document_validations.document_id, documentId))
      .orderBy(desc(document_validations.reviewed_at))
      .limit(1);

    let signedUrl: string | undefined = undefined;
    try {
      signedUrl = storageService.generateSignedUrl({
        file_key: docRow.file_key,
        expires_in_minutes: 180,
      }).signed_url;
    } catch {
      // Ignorar si no se puede generar URL firmada
    }

    return {
      id: docRow.id.toString(),
      supplier_id: docRow.supplier_id.toString(),
      type_document_id: docRow.type_document_id.toString(),
      type_name: docRow.type_name,
      file_key: docRow.file_key,
      file_url: signedUrl,
      upload_date: docRow.upload_date,
      due_date: docRow.due_date,
      is_public: isPublic,
      validation: validation
        ? {
            result: validation.result,
            comment: validation.comment,
            reviewed_at: validation.reviewed_at.toISOString(),
          }
        : null,
    };
  }

  /**
   * Verifica permisos sobre los documentos del proveedor
   */
  private async checkDocumentAccess(supplierId: bigint, user: AuthenticatedUser): Promise<void> {
    if (user.role === 'administrador') {
      return;
    }

    // Si es proveedor, verificar que sea el dueño de los documentos
    if (user.role === 'proveedor') {
      const [supplier] = await db
        .select({ id: suppliers.UniqueID })
        .from(suppliers)
        .where(eq(suppliers.user_id, BigInt(user.id)))
        .limit(1);

      if (supplier && supplier.id === supplierId) {
        return;
      }
    }

    // Si es gerente, verificar si administra alguna sucursal del negocio de este proveedor
    if (user.role === 'gerente') {
      const [managedBranch] = await db
        .select({ branchId: employees.branch_id })
        .from(employees)
        .innerJoin(branches, eq(employees.branch_id, branches.UniqueID))
        .innerJoin(business, eq(branches.business_id, business.UniqueID))
        .innerJoin(business_supplier, eq(business_supplier.business_id, business.UniqueID))
        .where(
          and(
            eq(employees.user_id, BigInt(user.id)),
            eq(business_supplier.supplier_id, supplierId),
            eq(employees.active, true),
          ),
        )
        .limit(1);

      if (managedBranch) {
        return;
      }
    }

    throw new ForbiddenError('No tienes permisos para modificar este documento.');
  }
}

export const supplierDocumentVisibilityService = new SupplierDocumentVisibilityService();
