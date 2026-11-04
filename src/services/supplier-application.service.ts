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
import type {
  CreateSupplierApplicationInput,
  SupplierApplicationResult,
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

// ============================================================================
// SERVICIO PRINCIPAL: ASISTENTE WEB DE REGISTRO
// ============================================================================

export class SupplierApplicationService {
  /**
   * Catálogo de documentos requeridos para el asistente de registro
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

      // 5.9 Documentos adjuntos (si fueron enviados en el registro)
      let documentsCreated = 0;
      const today = new Date().toISOString().split('T')[0];

      if (Array.isArray(input.documents) && input.documents.length > 0) {
        for (const doc of input.documents) {
          if (doc.type_document_id && doc.file_key) {
            await tx.insert(supplier_documents).values({
              supplier_id: newSupplier.id,
              type_document_id: BigInt(doc.type_document_id),
              file_key: doc.file_key,
              file_hash: doc.file_hash || null,
              upload_date: today,
              due_date: doc.due_date || null,
              is_public: false,
            });
            documentsCreated++;
          }
        }
      }

      // 5.10 Crear registro en supplier_applications
      // Fecha límite estimada de revisión (30 días naturales)
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
      // El error de evento no detiene la respuesta de la solicitud ya guardada
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
   * Consulta el estado de una solicitud (por ID de solicitud o por correo)
   */
  async getApplicationStatus(options: { applicationId?: string; email?: string }) {
    if (!options.applicationId && !options.email) {
      throw new BadRequestError(
        'Debes proporcionar el id de la solicitud o el correo del encargado.',
      );
    }

    let whereClause;
    if (options.applicationId) {
      whereClause = eq(supplier_applications.UniqueID, BigInt(options.applicationId));
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

    // Contar documentos
    const docs = await db
      .select({
        id: supplier_documents.UniqueID,
        type_document_id: supplier_documents.type_document_id,
        file_key: supplier_documents.file_key,
        upload_date: supplier_documents.upload_date,
      })
      .from(supplier_documents)
      .where(eq(supplier_documents.supplier_id, row.supplier_id));

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
      documents: docs.map((d) => ({
        id: d.id.toString(),
        type_document_id: d.type_document_id.toString(),
        file_key: d.file_key,
        upload_date: d.upload_date,
      })),
    };
  }
}

export const supplierApplicationService = new SupplierApplicationService();
