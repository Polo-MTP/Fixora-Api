import crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  supplier_applications,
  supplier_documents,
  suppliers,
  type_documents,
} from '../database/schema/tables.ts';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/index.ts';
import { SupplierVerificationEvent } from '../events/events/domain-events.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import { storageService } from './storage.service.ts';
import { validateDueDate } from './supplier-application.service.ts';
import { NON_PUBLISHABLE_DOC_PATTERN } from './supplier-document-visibility.service.ts';

/** Tipo que se usa cuando no se indica uno: «Certificaciones o Títulos Técnicos». */
const DEFAULT_CERTIFICATE_TYPE = /certificaci[oó]n|certificad|t[ií]tulo/i;

interface DocumentType {
  name: string;
  mandatory: boolean;
  active: boolean;
  supplier_type: string;
}

/**
 * Un proveedor aprobado puede subir documentos opcionales que se pueden mostrar en su ficha
 * (certificados, títulos, pólizas): no obligatorios, publicables y de su tipo de proveedor.
 * Los obligatorios y los de identidad se manejan en la solicitud de registro.
 */
export function isUploadableCertificateType(type: DocumentType, supplierType: string): boolean {
  return (
    type.active &&
    !type.mandatory &&
    !NON_PUBLISHABLE_DOC_PATTERN.test(type.name) &&
    (type.supplier_type === 'ambos' || type.supplier_type === supplierType)
  );
}

export interface UploadCertificateInput {
  file?: Express.Multer.File;
  typeDocumentId?: unknown;
  dueDate?: unknown;
}

export class SupplierCertificateService {
  /**
   * POST /api/supplier-documents (ANDROID-8): el proveedor aprobado sube un certificado nuevo.
   * Cada certificado es un documento aparte (no reemplaza a los anteriores) y queda pendiente
   * hasta que un administrador lo apruebe; ya aprobado, el proveedor decide si lo muestra.
   */
  async uploadCertificate(user: AuthenticatedUser, input: UploadCertificateInput) {
    if (user.role.trim().toLowerCase() !== 'proveedor') {
      throw new ForbiddenError('Solo el proveedor puede subir certificados a su perfil.');
    }
    if (!input.file) {
      throw new BadRequestError(
        'Adjunta el archivo del certificado (campo file).',
        'FILE_REQUIRED',
      );
    }

    // 1. Proveedor y estado de su solicitud: antes de aprobarse, los documentos van por la solicitud.
    const [supplier] = await db
      .select({
        id: suppliers.UniqueID,
        userId: suppliers.user_id,
        supplierType: suppliers.supplier_type,
        state: supplier_applications.state,
      })
      .from(suppliers)
      .innerJoin(supplier_applications, eq(supplier_applications.supplier_id, suppliers.UniqueID))
      .where(eq(suppliers.user_id, BigInt(user.id)))
      .orderBy(desc(supplier_applications.application_date), desc(supplier_applications.UniqueID))
      .limit(1);

    if (!supplier) {
      throw new NotFoundError('No se encontró tu registro de proveedor.', 'SUPPLIER_NOT_FOUND');
    }
    if (supplier.state !== 'aprobada') {
      throw new ConflictError(
        'Podrás subir certificados cuando tu solicitud de proveedor esté aprobada.',
        'APPLICATION_NOT_APPROVED',
      );
    }

    // 2. Tipo de documento: el indicado o, si no viene, el de certificaciones.
    const types = await db
      .select({
        id: type_documents.UniqueID,
        name: type_documents.name,
        mandatory: type_documents.mandatory,
        active: type_documents.active,
        supplier_type: type_documents.supplier_type,
        requires_expiration_date: type_documents.requires_expiration_date,
      })
      .from(type_documents);

    let type;
    if (input.typeDocumentId !== undefined && input.typeDocumentId !== '') {
      const typeId = String(input.typeDocumentId);
      if (!/^[1-9]\d{0,17}$/.test(typeId)) {
        throw new BadRequestError('type_document_id no es válido.', 'INVALID_DOCUMENT_TYPE');
      }
      type = types.find((t) => t.id === BigInt(typeId));
    } else {
      type = types.find(
        (t) =>
          DEFAULT_CERTIFICATE_TYPE.test(t.name) &&
          isUploadableCertificateType(t, supplier.supplierType),
      );
    }

    if (!type || !isUploadableCertificateType(type, supplier.supplierType)) {
      throw new BadRequestError(
        'Ese tipo de documento no se puede subir como certificado.',
        'INVALID_DOCUMENT_TYPE',
      );
    }

    const dueDate = validateDueDate(
      typeof input.dueDate === 'string' ? input.dueDate : null,
      type.requires_expiration_date,
      type.name,
    );

    // 3. Guardar el archivo. No es de verificación: una vez aprobado se puede mostrar en la ficha.
    const saved = await storageService.saveUploadedFile(
      input.file,
      'documents',
      supplier.userId.toString(),
      false,
    );
    const fileHash = crypto.createHash('sha256').update(input.file.buffer).digest('hex');

    const [doc] = await db
      .insert(supplier_documents)
      .values({
        supplier_id: supplier.id,
        type_document_id: type.id,
        file_key: saved.file_key,
        file_hash: fileHash,
        upload_date: new Date().toISOString().split('T')[0],
        due_date: dueDate,
        is_public: false,
      })
      .returning({
        id: supplier_documents.UniqueID,
        upload_date: supplier_documents.upload_date,
        due_date: supplier_documents.due_date,
      });

    // 4. Queda pendiente de revisión, igual que un documento reemplazado en la solicitud.
    const dispatch = await eventBus.notify(
      new SupplierVerificationEvent({
        supplierId: supplier.id.toString(),
        userId: supplier.userId.toString(),
        documentId: doc.id.toString(),
        documentName: type.name,
        result: 'pendiente',
        reviewedBy: supplier.userId.toString(),
        supplierType: supplier.supplierType,
        comment: 'Certificado subido por el proveedor; pendiente de revisión.',
      }),
    );
    if (dispatch.errors.some((entry) => entry.observerName === 'HistoryObserver')) {
      throw new AppError(
        'No fue posible registrar el certificado para su revisión.',
        500,
        'CERTIFICATE_UPLOAD_FAILED',
      );
    }

    return {
      id: doc.id.toString(),
      type_document_id: type.id.toString(),
      type_name: type.name,
      file_key: saved.file_key,
      upload_date: doc.upload_date,
      due_date: doc.due_date,
      is_public: false,
      validation: { result: 'pendiente', comment: null, reviewed_at: null },
    };
  }
}

export const supplierCertificateService = new SupplierCertificateService();
