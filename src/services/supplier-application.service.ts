import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  addresses,
  branches,
  branches_categories,
  branch_schedules,
  business,
  business_supplier,
  document_validations,
  employees,
  personal_data,
  roles,
  suppliers,
  supplier_applications,
  supplier_documents,
  type_documents,
  users,
} from '../database/schema/tables.ts';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../errors/app-error.ts';
import { eventBus } from '../events/index.ts';
import { SupplierVerificationEvent } from '../events/events/domain-events.ts';
import { storageService } from './storage.service.ts';
import type {
  CreateSupplierApplicationInput,
  ReplaceDocumentInput,
  SupplierApplicationResult,
  SupplierType,
  UploadDocumentInput,
} from '../types/supplier-application.types.ts';

// ============================================================================
// VALIDADORES AUXILIARES
// ============================================================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

function validateEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 255 || !EMAIL_REGEX.test(normalized)) {
    throw new BadRequestError('El correo electrónico no tiene un formato válido.');
  }
  return normalized;
}

function validatePassword(password: string): void {
  if (!password || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new BadRequestError(
      'La contraseña debe tener al menos 8 caracteres y un máximo de 72 bytes.',
    );
  }
}

function normalizeTime(timeStr: string): string {
  const trimmed = timeStr.trim();
  if (!TIME_REGEX.test(trimmed)) {
    throw new BadRequestError(
      `El horario '${timeStr}' debe tener el formato HH:MM (ej. 09:00 o 18:30).`,
    );
  }
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

export function validateDueDate(
  dueDateStr: string | null | undefined,
  requiresExpiration: boolean,
  docName = 'El documento',
): string | null {
  if (requiresExpiration) {
    if (!dueDateStr || !dueDateStr.trim()) {
      throw new BadRequestError(
        `El documento '${docName}' requiere indicar una fecha de vigencia/vencimiento.`,
        'EXPIRATION_DATE_REQUIRED',
      );
    }
  }

  if (!dueDateStr || !dueDateStr.trim()) {
    return null;
  }

  const trimmed = dueDateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new BadRequestError(
      `La fecha de vencimiento para '${docName}' debe tener el formato YYYY-MM-DD.`,
      'INVALID_DUE_DATE_FORMAT',
    );
  }

  const todayStr = new Date().toISOString().split('T')[0];
  if (trimmed <= todayStr) {
    throw new BadRequestError(
      `El documento '${docName}' está vencido; la fecha de vigencia (${trimmed}) debe ser posterior a la fecha actual.`,
      'DOCUMENT_EXPIRED',
    );
  }

  return trimmed;
}

// ============================================================================
// SERVICIO PRINCIPAL: ASISTENTE WEB DE REGISTRO
// ============================================================================

export class SupplierApplicationService {
  /**
   * Catálogo de documentos requeridos para el asistente de registro
   * Filtra según el tipo de proveedor (independiente, empresa o ambos)
   */
  async getDocumentTypes(supplierType?: 'independiente' | 'empresa' | 'ambos') {
    let whereClause = eq(type_documents.active, true);

    if (supplierType && supplierType !== 'ambos') {
      whereClause = and(
        eq(type_documents.active, true),
        or(
          eq(type_documents.supplier_type, supplierType),
          eq(type_documents.supplier_type, 'ambos'),
        ),
      )!;
    }

    const docs = await db
      .select({
        id: type_documents.UniqueID,
        name: type_documents.name,
        description: type_documents.description,
        requires_expiration_date: type_documents.requires_expiration_date,
        supplier_type: type_documents.supplier_type,
        mandatory: type_documents.mandatory,
      })
      .from(type_documents)
      .where(whereClause);

    return docs.map((doc) => ({
      ...doc,
      id: doc.id.toString(),
    }));
  }

  /**
   * Crea la solicitud completa del asistente web de registro
   */
  async createApplication(
    input: CreateSupplierApplicationInput,
  ): Promise<SupplierApplicationResult> {
    // 1. Validaciones básicas del Encargado
    if (!input.manager) {
      throw new BadRequestError('Los datos del encargado son obligatorios.');
    }
    const managerEmail = validateEmail(input.manager.email);
    validatePassword(input.manager.password);

    const managerName = input.manager.name?.trim();
    const managerLastnameP = input.manager.lastname_p?.trim();
    if (!managerName || !managerLastnameP) {
      throw new BadRequestError('El nombre y apellido paterno del encargado son obligatorios.');
    }

    // 2. Validaciones de tipo de proveedor y negocio
    if (input.supplier_type !== 'independiente' && input.supplier_type !== 'empresa') {
      throw new BadRequestError("El tipo de proveedor debe ser 'independiente' o 'empresa'.");
    }

    if (!input.business || !input.business.name?.trim()) {
      throw new BadRequestError('El nombre del negocio es obligatorio.');
    }
    const businessName = input.business.name.trim();

    // 3. Validaciones de sucursales / locales
    if (!Array.isArray(input.branches) || input.branches.length === 0) {
      throw new BadRequestError(
        'Debes registrar al menos una sucursal o local con dirección, horarios y categorías.',
      );
    }

    if (input.supplier_type === 'independiente' && input.branches.length > 1) {
      throw new BadRequestError(
        'Un proveedor independiente solo puede registrar una sucursal o local principal.',
      );
    }

    for (const [index, branch] of input.branches.entries()) {
      if (!branch.name?.trim()) {
        throw new BadRequestError(`El nombre de la sucursal #${index + 1} es obligatorio.`);
      }

      // Validar dirección
      const addr = branch.address;
      if (
        !addr ||
        !addr.street?.trim() ||
        !addr.num_ext?.trim() ||
        !addr.colony?.trim() ||
        !addr.municipality?.trim() ||
        !addr.state?.trim() ||
        !addr.postal_code?.trim()
      ) {
        throw new BadRequestError(
          `La dirección completa de la sucursal #${index + 1} es obligatoria (calle, num_ext, colonia, municipio, estado, código postal).`,
        );
      }

      // Validar horarios
      if (!Array.isArray(branch.schedules) || branch.schedules.length === 0) {
        throw new BadRequestError(
          `La sucursal '${branch.name}' debe incluir al menos un horario de atención.`,
        );
      }

      for (const schedule of branch.schedules) {
        if (
          typeof schedule.day_of_week !== 'number' ||
          schedule.day_of_week < 0 ||
          schedule.day_of_week > 6
        ) {
          throw new BadRequestError(
            `El día de la semana (${schedule.day_of_week}) debe ser un número entero de 0 (domingo) a 6 (sábado).`,
          );
        }
        schedule.open_time = normalizeTime(schedule.open_time);
        schedule.close_time = normalizeTime(schedule.close_time);
      }

      // Validar categorías
      if (!Array.isArray(branch.categories) || branch.categories.length === 0) {
        throw new BadRequestError(
          `La sucursal '${branch.name}' debe estar asignada a al menos una categoría de servicio.`,
        );
      }

      for (const cat of branch.categories) {
        if (!cat.category_id) {
          throw new BadRequestError('El identificador de categoría (category_id) es obligatorio.');
        }
        const price = Number(cat.base_price);
        if (isNaN(price) || price <= 0) {
          throw new BadRequestError(
            `El precio base para la categoría ${cat.category_id} debe ser un valor positivo.`,
          );
        }
      }
    }

    // 4. Verificar duplicados (correo y RFC)
    const [existingUser] = await db
      .select({ id: users.UniqueID })
      .from(users)
      .where(eq(users.email, managerEmail))
      .limit(1);

    if (existingUser) {
      throw new ConflictError(
        'Ya existe una cuenta registrada con este correo electrónico.',
        'EMAIL_ALREADY_REGISTERED',
      );
    }

    const rfcNormalized = input.rfc?.trim().toUpperCase() || null;
    if (rfcNormalized) {
      const [existingRfc] = await db
        .select({ id: suppliers.UniqueID })
        .from(suppliers)
        .where(eq(suppliers.rfc, rfcNormalized))
        .limit(1);

      if (existingRfc) {
        throw new ConflictError(
          'El RFC proporcionado ya se encuentra registrado en el sistema.',
          'RFC_ALREADY_REGISTERED',
        );
      }
    }

    // 5. Transacción atómica en Base de Datos
    const result = await db.transaction(async (tx) => {
      // 5.1 Buscar Rol 'proveedor'
      const [roleProveedor] = await tx
        .select({ id: roles.UniqueID })
        .from(roles)
        .where(and(eq(roles.name, 'proveedor'), eq(roles.active, true)))
        .limit(1);

      if (!roleProveedor) {
        throw new AppError(
          'No se encontró disponible el rol de proveedor en el sistema.',
          500,
          'ROLE_NOT_FOUND',
        );
      }

      // 5.2 Hash de contraseña
      const passwordHash = await bcrypt.hash(input.manager.password, 12);

      // 5.3 Crear usuario encargado en estado 'por_aprobar'
      const [newUser] = await tx
        .insert(users)
        .values({
          email: managerEmail,
          password_hash: passwordHash,
          role_id: roleProveedor.id,
          state: 'por_aprobar',
        })
        .returning({ id: users.UniqueID });

      // 5.4 Crear datos personales del encargado
      await tx.insert(personal_data).values({
        user_id: newUser.id,
        name: managerName,
        lastname_p: managerLastnameP,
        lastname_m: input.manager.lastname_m?.trim() || null,
        birth_date: input.manager.birth_date || null,
        phone: input.manager.phone?.trim() || null,
      });

      // 5.5 Crear registro de Proveedor
      const [newSupplier] = await tx
        .insert(suppliers)
        .values({
          user_id: newUser.id,
          supplier_type: input.supplier_type,
          rfc: rfcNormalized,
          active: true,
        })
        .returning({ id: suppliers.UniqueID });

      // 5.6 Crear registro del Negocio
      const [newBusiness] = await tx
        .insert(business)
        .values({
          name: businessName,
          tax_identification: input.business.tax_identification?.trim() || rfcNormalized,
          email: input.business.email ? validateEmail(input.business.email) : managerEmail,
          phone: input.business.phone?.trim() || input.manager.phone?.trim() || null,
        })
        .returning({ id: business.UniqueID });

      // 5.7 Vincular Negocio y Proveedor
      await tx.insert(business_supplier).values({
        business_id: newBusiness.id,
        supplier_id: newSupplier.id,
      });

      let branchesCreated = 0;

      // 5.8 Crear Sucursales, Direcciones, Horarios y Categorías
      for (const branchInput of input.branches) {
        const addrInput = branchInput.address;

        const [newAddress] = await tx
          .insert(addresses)
          .values({
            street: addrInput.street.trim(),
            num_ext: addrInput.num_ext.trim(),
            num_int: addrInput.num_int?.trim() || null,
            colony: addrInput.colony.trim(),
            municipality: addrInput.municipality.trim(),
            state: addrInput.state.trim(),
            postal_code: addrInput.postal_code.trim(),
            country: addrInput.country?.trim() || 'México',
            latitude:
              addrInput.latitude !== undefined && addrInput.latitude !== null
                ? String(addrInput.latitude)
                : null,
            longitude:
              addrInput.longitude !== undefined && addrInput.longitude !== null
                ? String(addrInput.longitude)
                : null,
            reference: addrInput.reference?.trim() || null,
          })
          .returning({ id: addresses.UniqueID });

        const [newBranch] = await tx
          .insert(branches)
          .values({
            business_id: newBusiness.id,
            address_id: newAddress.id,
            name: branchInput.name.trim(),
            phone: branchInput.phone?.trim() || input.business.phone?.trim() || null,
            email: branchInput.email ? validateEmail(branchInput.email) : null,
            description: branchInput.description?.trim() || null,
            timezone: 'America/Mexico_City',
            accepting_request: true,
          })
          .returning({ id: branches.UniqueID });

        branchesCreated++;

        // Horarios de la sucursal
        for (const sched of branchInput.schedules) {
          await tx.insert(branch_schedules).values({
            branch_id: newBranch.id,
            day_of_week: sched.day_of_week,
            open_time: sched.open_time,
            close_time: sched.close_time,
            active: true,
          });
        }

        // Categorías de la sucursal
        for (const cat of branchInput.categories) {
          await tx.insert(branches_categories).values({
            branch_id: newBranch.id,
            category_id: BigInt(cat.category_id),
            base_price: String(cat.base_price),
            duration_minutes: cat.duration_minutes ?? 60,
            active: true,
          });
        }

        // Empleados iniciales (si aplica)
        if (Array.isArray(branchInput.employees) && branchInput.employees.length > 0) {
          for (const emp of branchInput.employees) {
            const empEmail = validateEmail(emp.email);
            validatePassword(emp.password);

            const [roleEmp] = await tx
              .select({ id: roles.UniqueID })
              .from(roles)
              .where(eq(roles.name, emp.role))
              .limit(1);

            if (roleEmp) {
              const empHash = await bcrypt.hash(emp.password, 12);
              const [empUser] = await tx
                .insert(users)
                .values({
                  email: empEmail,
                  password_hash: empHash,
                  role_id: roleEmp.id,
                  state: 'por_aprobar',
                })
                .returning({ id: users.UniqueID });

              await tx.insert(personal_data).values({
                user_id: empUser.id,
                name: emp.name.trim(),
                lastname_p: emp.lastname_p.trim(),
                lastname_m: emp.lastname_m?.trim() || null,
                phone: emp.phone?.trim() || null,
              });

              await tx.insert(employees).values({
                user_id: empUser.id,
                branch_id: newBranch.id,
                can_attend: emp.can_attend ?? true,
                active: true,
              });
            }
          }
        }
      }

      // 5.9 Documentos adjuntos con validación de vencimiento y hash
      let documentsCreated = 0;
      const today = new Date().toISOString().split('T')[0];

      if (Array.isArray(input.documents) && input.documents.length > 0) {
        for (const doc of input.documents) {
          if (doc.type_document_id && doc.file_key) {
            const [docType] = await tx
              .select()
              .from(type_documents)
              .where(eq(type_documents.UniqueID, BigInt(doc.type_document_id)))
              .limit(1);

            const validatedDueDate = docType
              ? validateDueDate(doc.due_date, docType.requires_expiration_date, docType.name)
              : doc.due_date || null;

            const fileHash =
              doc.file_hash || crypto.createHash('sha256').update(doc.file_key).digest('hex');

            await tx.insert(supplier_documents).values({
              supplier_id: newSupplier.id,
              type_document_id: BigInt(doc.type_document_id),
              file_key: doc.file_key,
              file_hash: fileHash,
              upload_date: today,
              due_date: validatedDueDate,
              is_public: false,
            });
            documentsCreated++;
          }
        }
      }

      // 5.10 Crear registro en supplier_applications
      const dueDateObj = new Date();
      dueDateObj.setDate(dueDateObj.getDate() + 30);
      const dueDate = dueDateObj.toISOString().split('T')[0];

      const [newApplication] = await tx
        .insert(supplier_applications)
        .values({
          supplier_id: newSupplier.id,
          supplier_type: input.supplier_type,
          state: 'pendiente',
          comments: input.comments?.trim() || null,
          application_date: today,
          due_date: dueDate,
        })
        .returning({ id: supplier_applications.UniqueID });

      return {
        applicationId: newApplication.id.toString(),
        supplierId: newSupplier.id.toString(),
        userId: newUser.id.toString(),
        supplierType: input.supplier_type,
        state: 'pendiente',
        applicationDate: today,
        dueDate,
        businessName,
        managerName: `${managerName} ${managerLastnameP}`,
        email: managerEmail,
        branchesCreated,
        documentsCreated,
      };
    });

    // 6. Emitir evento de dominio con el patrón Observer
    try {
      await eventBus.notify(
        new SupplierVerificationEvent({
          supplierId: result.supplierId,
          userId: result.userId,
          result: 'pendiente',
          reviewedBy: 'system',
          supplierType: result.supplierType,
          comment: `Nueva solicitud de proveedor registrada (${result.businessName}).`,
        }),
      );
    } catch (eventErr) {
      console.error('[SupplierApplicationService] Error al emitir evento de dominio:', eventErr);
    }

    return {
      id: result.applicationId,
      supplier_id: result.supplierId,
      supplier_type: result.supplierType,
      state: result.state,
      application_date: result.applicationDate,
      due_date: result.dueDate,
      business_name: result.businessName,
      manager_name: result.managerName,
      email: result.email,
      branches_count: result.branchesCreated,
      documents_count: result.documentsCreated,
    };
  }

  /**
   * Sube o registra un documento individual para un proveedor con hash y fecha de vencimiento
   */
  async uploadSupplierDocument(input: UploadDocumentInput) {
    const supplierId = BigInt(input.supplierId);
    const typeDocId = BigInt(input.typeDocumentId);

    const [supplier] = await db
      .select({ id: suppliers.UniqueID })
      .from(suppliers)
      .where(eq(suppliers.UniqueID, supplierId))
      .limit(1);

    if (!supplier) {
      throw new NotFoundError('No se encontró el proveedor especificado.', 'SUPPLIER_NOT_FOUND');
    }

    const [docType] = await db
      .select()
      .from(type_documents)
      .where(eq(type_documents.UniqueID, typeDocId))
      .limit(1);

    if (!docType) {
      throw new NotFoundError(
        'El tipo de documento especificado no existe.',
        'DOCUMENT_TYPE_NOT_FOUND',
      );
    }

    const validatedDueDate = validateDueDate(
      input.dueDate,
      docType.requires_expiration_date,
      docType.name,
    );

    const fileHash =
      input.fileHash || crypto.createHash('sha256').update(input.fileKey).digest('hex');
    const today = new Date().toISOString().split('T')[0];

    // Verificar si ya existe un documento para este tipo y proveedor
    const [existingDoc] = await db
      .select({ id: supplier_documents.UniqueID })
      .from(supplier_documents)
      .where(
        and(
          eq(supplier_documents.supplier_id, supplierId),
          eq(supplier_documents.type_document_id, typeDocId),
        ),
      )
      .limit(1);

    let docId: bigint;
    if (existingDoc) {
      await db
        .update(supplier_documents)
        .set({
          file_key: input.fileKey,
          file_hash: fileHash,
          upload_date: today,
          due_date: validatedDueDate,
        })
        .where(eq(supplier_documents.UniqueID, existingDoc.id));
      docId = existingDoc.id;
    } else {
      const [inserted] = await db
        .insert(supplier_documents)
        .values({
          supplier_id: supplierId,
          type_document_id: typeDocId,
          file_key: input.fileKey,
          file_hash: fileHash,
          upload_date: today,
          due_date: validatedDueDate,
          is_public: false,
        })
        .returning({ id: supplier_documents.UniqueID });
      docId = inserted.id;
    }

    return {
      id: docId.toString(),
      supplier_id: supplierId.toString(),
      type_document_id: typeDocId.toString(),
      type_name: docType.name,
      file_key: input.fileKey,
      file_hash: fileHash,
      upload_date: today,
      due_date: validatedDueDate,
    };
  }

  /**
   * Reemplaza un documento cuando la solicitud está en 'documentacion_incompleta'
   * Al subsanar los documentos requeridos, la solicitud regresa automáticamente a 'pendiente'
   */
  async replaceDocument(input: ReplaceDocumentInput) {
    if (!input.applicationId && !input.userId) {
      throw new BadRequestError(
        'Debes proporcionar el ID de la solicitud o la sesión del proveedor.',
      );
    }

    // 1. Localizar la solicitud de proveedor
    let applicationRow;
    if (input.userId) {
      const rows = await db
        .select({
          application_id: supplier_applications.UniqueID,
          application_state: supplier_applications.state,
          supplier_id: suppliers.UniqueID,
          supplier_type: suppliers.supplier_type,
          user_id: suppliers.user_id,
        })
        .from(supplier_applications)
        .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
        .where(eq(suppliers.user_id, BigInt(input.userId)))
        .orderBy(desc(supplier_applications.application_date))
        .limit(1);
      applicationRow = rows[0];
    } else {
      const rows = await db
        .select({
          application_id: supplier_applications.UniqueID,
          application_state: supplier_applications.state,
          supplier_id: suppliers.UniqueID,
          supplier_type: suppliers.supplier_type,
          user_id: suppliers.user_id,
        })
        .from(supplier_applications)
        .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
        .where(eq(supplier_applications.UniqueID, BigInt(input.applicationId!)))
        .limit(1);
      applicationRow = rows[0];
    }

    if (!applicationRow) {
      throw new NotFoundError(
        'No se encontró la solicitud de proveedor correspondiente.',
        'APPLICATION_NOT_FOUND',
      );
    }

    // 2. Validar estado de la solicitud
    if (applicationRow.application_state === 'aprobada') {
      throw new ConflictError(
        'La solicitud ya se encuentra aprobada y no requiere reemplazar documentos.',
        'APPLICATION_ALREADY_APPROVED',
      );
    }

    if (
      applicationRow.application_state !== 'documentacion_incompleta' &&
      applicationRow.application_state !== 'rechazada'
    ) {
      throw new ConflictError(
        `La solicitud se encuentra en estado '${applicationRow.application_state}'. Solo se pueden reemplazar documentos cuando la solicitud vuelve como 'documentacion_incompleta'.`,
        'APPLICATION_NOT_EDITABLE',
      );
    }

    // 3. Procesar archivo o clave
    let fileKey = input.fileKey;
    let fileHash = input.fileHash || null;

    if (input.file) {
      storageService.validateFile(input.file, 'documents');
      const saved = await storageService.saveUploadedFile(input.file, 'documents');
      fileKey = saved.file_key;
      fileHash = crypto.createHash('sha256').update(input.file.buffer).digest('hex');
    }

    if (!fileKey) {
      throw new BadRequestError(
        'Debes adjuntar el archivo o proporcionar la clave del documento (file_key).',
        'FILE_REQUIRED',
      );
    }

    // 4. Subir / reemplazar el documento
    const uploadedDoc = await this.uploadSupplierDocument({
      supplierId: applicationRow.supplier_id,
      typeDocumentId: input.typeDocumentId,
      fileKey,
      fileHash,
      dueDate: input.dueDate,
    });

    // 5. Verificar si se completaron todos los documentos requeridos
    const isComplete = await this.checkMandatoryDocumentsComplete(
      applicationRow.supplier_id,
      applicationRow.supplier_type as SupplierType,
    );

    let updatedState: string = applicationRow.application_state;
    if (isComplete) {
      await db
        .update(supplier_applications)
        .set({
          state: 'pendiente',
        })
        .where(eq(supplier_applications.UniqueID, applicationRow.application_id));

      updatedState = 'pendiente';

      // Notificar mediante el bus de eventos
      try {
        await eventBus.notify(
          new SupplierVerificationEvent({
            supplierId: applicationRow.supplier_id.toString(),
            userId: applicationRow.user_id.toString(),
            documentId: uploadedDoc.id,
            result: 'pendiente',
            reviewedBy: 'supplier',
            supplierType: applicationRow.supplier_type,
            comment:
              'Documentación incompleta subsanada por el proveedor. Solicitud enviada a revisión.',
          }),
        );
      } catch (err) {
        console.error('[SupplierApplicationService] Error al emitir evento de verificación:', err);
      }
    }

    return {
      document: uploadedDoc,
      application_id: applicationRow.application_id.toString(),
      application_state: updatedState,
      is_complete: isComplete,
      message: isComplete
        ? 'Documento reemplazado con éxito. Se han completado los documentos obligatorios y tu solicitud ha regresado a estado pendiente de revisión.'
        : 'Documento reemplazado con éxito.',
    };
  }

  /**
   * Revisa si un proveedor ya cuenta con todos los documentos obligatorios subidos
   */
  async checkMandatoryDocumentsComplete(
    supplierId: bigint,
    supplierType: SupplierType,
  ): Promise<boolean> {
    const mandatoryTypes = await db
      .select({ id: type_documents.UniqueID })
      .from(type_documents)
      .where(
        and(
          eq(type_documents.active, true),
          eq(type_documents.mandatory, true),
          or(
            eq(type_documents.supplier_type, supplierType),
            eq(type_documents.supplier_type, 'ambos'),
          ),
        ),
      );

    if (mandatoryTypes.length === 0) {
      return true;
    }

    const uploadedDocs = await db
      .select({
        id: supplier_documents.UniqueID,
        type_document_id: supplier_documents.type_document_id,
      })
      .from(supplier_documents)
      .where(eq(supplier_documents.supplier_id, supplierId));

    const uploadedTypeIds = new Set(uploadedDocs.map((d) => d.type_document_id.toString()));

    for (const m of mandatoryTypes) {
      if (!uploadedTypeIds.has(m.id.toString())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Consulta el estado de una solicitud (por ID de solicitud, ID de proveedor o por correo)
   */
  async getApplicationStatus(options: {
    applicationId?: string;
    email?: string;
    supplierId?: string;
  }) {
    if (!options.applicationId && !options.email && !options.supplierId) {
      throw new BadRequestError(
        'Debes proporcionar el id de la solicitud, el id del proveedor o el correo del encargado.',
      );
    }

    let whereClause;
    if (options.applicationId) {
      whereClause = eq(supplier_applications.UniqueID, BigInt(options.applicationId));
    } else if (options.supplierId) {
      whereClause = eq(supplier_applications.supplier_id, BigInt(options.supplierId));
    } else {
      whereClause = eq(users.email, options.email!.trim().toLowerCase());
    }

    const rows = await db
      .select({
        application_id: supplier_applications.UniqueID,
        state: supplier_applications.state,
        supplier_type: supplier_applications.supplier_type,
        application_date: supplier_applications.application_date,
        due_date: supplier_applications.due_date,
        comments: supplier_applications.comments,
        supplier_id: suppliers.UniqueID,
        rfc: suppliers.rfc,
        business_name: business.name,
        manager_email: users.email,
        manager_state: users.state,
        manager_name: personal_data.name,
        manager_lastname: personal_data.lastname_p,
      })
      .from(supplier_applications)
      .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
      .innerJoin(users, eq(suppliers.user_id, users.UniqueID))
      .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
      .leftJoin(business_supplier, eq(suppliers.UniqueID, business_supplier.supplier_id))
      .leftJoin(business, eq(business_supplier.business_id, business.UniqueID))
      .where(whereClause)
      .orderBy(desc(supplier_applications.application_date))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundError(
        'No se encontró ninguna solicitud de proveedor con los datos especificados.',
      );
    }

    const row = rows[0];

    // Obtener documentos con sus validaciones más recientes
    const docs = await db
      .select({
        id: supplier_documents.UniqueID,
        type_document_id: supplier_documents.type_document_id,
        type_name: type_documents.name,
        requires_expiration_date: type_documents.requires_expiration_date,
        mandatory: type_documents.mandatory,
        file_key: supplier_documents.file_key,
        file_hash: supplier_documents.file_hash,
        upload_date: supplier_documents.upload_date,
        due_date: supplier_documents.due_date,
      })
      .from(supplier_documents)
      .innerJoin(type_documents, eq(supplier_documents.type_document_id, type_documents.UniqueID))
      .where(eq(supplier_documents.supplier_id, row.supplier_id));

    const docsWithValidations = await Promise.all(
      docs.map(async (doc) => {
        const [validation] = await db
          .select({
            result: document_validations.result,
            comment: document_validations.comment,
            reviewed_at: document_validations.reviewed_at,
          })
          .from(document_validations)
          .where(eq(document_validations.document_id, doc.id))
          .orderBy(desc(document_validations.reviewed_at))
          .limit(1);

        return {
          id: doc.id.toString(),
          type_document_id: doc.type_document_id.toString(),
          type_name: doc.type_name,
          requires_expiration_date: doc.requires_expiration_date,
          mandatory: doc.mandatory,
          file_key: doc.file_key,
          file_hash: doc.file_hash,
          upload_date: doc.upload_date,
          due_date: doc.due_date,
          validation: validation || null,
        };
      }),
    );

    return {
      id: row.application_id.toString(),
      state: row.state,
      supplier_type: row.supplier_type,
      application_date: row.application_date,
      due_date: row.due_date,
      comments: row.comments,
      rfc: row.rfc,
      business_name: row.business_name || 'Sin nombre',
      manager_name: `${row.manager_name || ''} ${row.manager_lastname || ''}`.trim(),
      email: row.manager_email,
      manager_state: row.manager_state,
      documents: docsWithValidations,
    };
  }

  /**
   * Consulta la solicitud y documentos del proveedor autenticado
   */
  async getMyApplication(userId: string | bigint) {
    const [supplier] = await db
      .select({ id: suppliers.UniqueID })
      .from(suppliers)
      .where(eq(suppliers.user_id, BigInt(userId)))
      .limit(1);

    if (!supplier) {
      throw new NotFoundError(
        'No tienes una solicitud de proveedor registrada.',
        'APPLICATION_NOT_FOUND',
      );
    }

    return this.getApplicationStatus({ supplierId: supplier.id.toString() });
  }
}

export const supplierApplicationService = new SupplierApplicationService();
