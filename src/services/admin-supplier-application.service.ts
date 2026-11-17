import { and, asc, countDistinct, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
    address_user,
    addresses,
    branches,
    branches_categories,
    branch_schedules,
    business,
    business_supplier,
    categories,
    document_validations,
    employees,
    personal_data,
    roles,
    supplier_applications,
    supplier_documents,
    suppliers,
    type_documents,
    users,
} from '../database/schema/tables.ts';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import {
    SupplierVerificationEvent,
    SupplierApplicationResolvedEvent,
} from '../events/events/domain-events.ts';

const APPLICATION_STATES = [
    'pendiente',
    'aprobada',
    'rechazada',
    'documentacion_incompleta',
] as const;

type ApplicationState = (typeof APPLICATION_STATES)[number];
type DocumentResult = 'aprobado' | 'rechazado';

function parseId(value: string, field = 'id'): bigint {
    if (!/^\d{1,18}$/.test(value)) {
        throw new BadRequestError(
            `El campo ${field} debe ser un identificador BIGINT válido.`,
            'INVALID_ID',
        );
    }
    const parsed = BigInt(value);
    if (parsed <= 0n) {
        throw new BadRequestError(`El campo ${field} debe ser mayor que cero.`, 'INVALID_ID');
    }
    return parsed;
}

function normalizeComment(value: unknown, required: boolean, maxLength: number): string | null {
    if (value === undefined || value === null) {
        if (required)
            throw new BadRequestError('Debes proporcionar un comentario o motivo.', 'COMMENT_REQUIRED');
        return null;
    }
    if (typeof value !== 'string') {
        throw new BadRequestError('El comentario debe ser una cadena de texto.', 'INVALID_COMMENT');
    }
    const comment = value.trim();
    if (required && !comment) {
        throw new BadRequestError('Debes proporcionar un comentario o motivo.', 'COMMENT_REQUIRED');
    }
    if (comment.length > maxLength) {
        throw new BadRequestError(
            `El comentario no puede superar los ${maxLength} caracteres.`,
            'INVALID_COMMENT',
        );
    }
    return comment || null;
}

function parseApplicationState(value: string | undefined): ApplicationState | undefined {
    if (value === undefined || value === '') return undefined;
    if (!APPLICATION_STATES.includes(value as ApplicationState)) {
        throw new BadRequestError(
            `El estado debe ser uno de: ${APPLICATION_STATES.join(', ')}.`,
            'INVALID_APPLICATION_STATE',
        );
    }
    return value as ApplicationState;
}

function toNumberOrNull(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTime(value: string): string {
    return value.slice(0, 5);
}

interface DocumentForReview {
    id: bigint;
    type_document_id: bigint;
    type_name: string;
    file_key: string;
    upload_date: string;
    due_date: string | null;
    is_public: boolean;
    validation: {
        result: string;
        comment: string | null;
        reviewed_at: Date;
    } | null;
}

export class AdminSupplierApplicationService {
    private async getDocuments(supplierId: bigint): Promise<DocumentForReview[]> {
        const docs = await db
            .select({
                id: supplier_documents.UniqueID,
                type_document_id: supplier_documents.type_document_id,
                type_name: type_documents.name,
                file_key: supplier_documents.file_key,
                upload_date: supplier_documents.upload_date,
                due_date: supplier_documents.due_date,
                is_public: supplier_documents.is_public,
            })
            .from(supplier_documents)
            .innerJoin(type_documents, eq(supplier_documents.type_document_id, type_documents.UniqueID))
            .where(eq(supplier_documents.supplier_id, supplierId))
            .orderBy(asc(supplier_documents.UniqueID));

        if (docs.length === 0) return [];

        const validations = await db
            .select({
                document_id: document_validations.document_id,
                result: document_validations.result,
                comment: document_validations.comment,
                reviewed_at: document_validations.reviewed_at,
            })
            .from(document_validations)
            .where(
                inArray(
                    document_validations.document_id,
                    docs.map((doc) => doc.id),
                ),
            )
            .orderBy(
                asc(document_validations.document_id),
                desc(document_validations.reviewed_at),
                desc(document_validations.UniqueID),
            );

        const latestByDocument = new Map<bigint, (typeof validations)[number]>();
        for (const validation of validations) {
            if (!latestByDocument.has(validation.document_id)) {
                latestByDocument.set(validation.document_id, validation);
            }
        }

        return docs.map((doc) => {
            const validation = latestByDocument.get(doc.id);
            return {
                ...doc,
                validation: validation
                    ? {
                        result: validation.result,
                        comment: validation.comment,
                        reviewed_at: validation.reviewed_at,
                    }
                    : null,
            };
        });
    }

    private async getPendingDocumentInfo(
        supplierId: bigint,
        supplierType: 'independiente' | 'empresa',
        docs: DocumentForReview[],
    ): Promise<{ count: number; names: string[] }> {
        const mandatoryTypes = await db
            .select({ id: type_documents.UniqueID, name: type_documents.name })
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

        const uploadedTypeIds = new Set(docs.map((doc) => doc.type_document_id.toString()));
        const missingMandatory = mandatoryTypes.filter(
            (docType) => !uploadedTypeIds.has(docType.id.toString()),
        );
        const unapproved = docs.filter((doc) => doc.validation?.result !== 'aprobado');

        return {
            count: missingMandatory.length + unapproved.length,
            names: [
                ...missingMandatory.map((docType) => docType.name),
                ...unapproved.map((doc) => doc.type_name),
            ],
        };
    }

    private async getApplicationBase(applicationId: bigint) {
        const [row] = await db
            .select({
                application_id: supplier_applications.UniqueID,
                state: supplier_applications.state,
                supplier_type: supplier_applications.supplier_type,
                application_date: supplier_applications.application_date,
                comments: supplier_applications.comments,
                supplier_id: suppliers.UniqueID,
                supplier_user_id: users.UniqueID,
                supplier_active: suppliers.active,
                rfc: suppliers.rfc,
                email: users.email,
                user_state: users.state,
                manager_name: personal_data.name,
                manager_lastname_p: personal_data.lastname_p,
                manager_lastname_m: personal_data.lastname_m,
                business_id: business.UniqueID,
                business_name: business.name,
                business_tax_identification: business.tax_identification,
                business_email: business.email,
                business_phone: business.phone,
            })
            .from(supplier_applications)
            .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
            .innerJoin(users, eq(suppliers.user_id, users.UniqueID))
            .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
            .leftJoin(
                business_supplier,
                and(
                    eq(suppliers.UniqueID, business_supplier.supplier_id),
                    eq(business_supplier.active, true),
                ),
            )
            .leftJoin(business, eq(business_supplier.business_id, business.UniqueID))
            .where(eq(supplier_applications.UniqueID, applicationId))
            .limit(1);

        if (!row) throw new NotFoundError('No se encontró la solicitud de proveedor.', 'NOT_FOUND');
        return row;
    }

    async getApplicationDetail(applicationIdInput: string) {
        const applicationId = parseId(applicationIdInput);
        const row = await this.getApplicationBase(applicationId);
        const docs = await this.getDocuments(row.supplier_id);
        const pending = await this.getPendingDocumentInfo(row.supplier_id, row.supplier_type, docs);

        let branchData: Array<Record<string, unknown>> = [];

        if (row.business_id) {
            const branchRows = await db
                .select({
                    id: branches.UniqueID,
                    name: branches.name,
                    address_id: addresses.UniqueID,
                    address_alias: address_user.alias,
                    address_reference: addresses.reference,
                    street: addresses.street,
                    num_ext: addresses.num_ext,
                    num_int: addresses.num_int,
                    colony: addresses.colony,
                    municipality: addresses.municipality,
                    state: addresses.state,
                    postal_code: addresses.postal_code,
                    country: addresses.country,
                    latitude: addresses.latitude,
                    longitude: addresses.longitude,
                    is_main: address_user.is_main,
                })
                .from(branches)
                .innerJoin(addresses, eq(branches.address_id, addresses.UniqueID))
                .leftJoin(
                    address_user,
                    and(
                        eq(address_user.address_id, addresses.UniqueID),
                        eq(address_user.user_id, row.supplier_user_id),
                        eq(address_user.active, true),
                    ),
                )
                .where(eq(branches.business_id, row.business_id))
                .orderBy(asc(branches.UniqueID));

            branchData = await Promise.all(
                branchRows.map(async (branch) => {
                    const [schedules, branchCategories, branchEmployees] = await Promise.all([
                        db
                            .select({
                                day_of_week: branch_schedules.day_of_week,
                                open_time: branch_schedules.open_time,
                                close_time: branch_schedules.close_time,
                            })
                            .from(branch_schedules)
                            .where(
                                and(eq(branch_schedules.branch_id, branch.id), eq(branch_schedules.active, true)),
                            )
                            .orderBy(asc(branch_schedules.day_of_week)),
                        db
                            .select({
                                category_id: categories.UniqueID,
                                base_price: branches_categories.base_price,
                                duration_minutes: branches_categories.duration_minutes,
                                category_name: categories.name,
                                icon_key: categories.icon_key,
                            })
                            .from(branches_categories)
                            .innerJoin(categories, eq(branches_categories.category_id, categories.UniqueID))
                            .where(
                                and(
                                    eq(branches_categories.branch_id, branch.id),
                                    eq(branches_categories.active, true),
                                    eq(categories.active, true),
                                ),
                            )
                            .orderBy(asc(categories.sort_order)),
                        db
                            .select({
                                id: employees.UniqueID,
                                user_id: users.UniqueID,
                                branch_id: employees.branch_id,
                                email: users.email,
                                name: personal_data.name,
                                lastname_p: personal_data.lastname_p,
                                role: roles.name,
                                can_attend: employees.can_attend,
                                active: employees.active,
                            })
                            .from(employees)
                            .innerJoin(users, eq(employees.user_id, users.UniqueID))
                            .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
                            .leftJoin(roles, eq(users.role_id, roles.UniqueID))
                            .where(eq(employees.branch_id, branch.id))
                            .orderBy(asc(employees.UniqueID)),
                    ]);

                    return {
                        id: branch.id.toString(),
                        name: branch.name,
                        address: {
                            id: branch.address_id.toString(),
                            alias: branch.address_alias,
                            reference: branch.address_reference,
                            street: branch.street,
                            num_ext: branch.num_ext,
                            num_int: branch.num_int,
                            colony: branch.colony,
                            municipality: branch.municipality,
                            state: branch.state,
                            postal_code: branch.postal_code,
                            country: branch.country,
                            latitude: toNumberOrNull(branch.latitude),
                            longitude: toNumberOrNull(branch.longitude),
                            is_main: branch.is_main ?? false,
                        },
                        schedules: schedules.map((schedule) => ({
                            day_of_week: schedule.day_of_week,
                            open_time: normalizeTime(schedule.open_time),
                            close_time: normalizeTime(schedule.close_time),
                        })),
                        categories: branchCategories.map((category) => ({
                            category_id: category.category_id.toString(),
                            base_price: category.base_price,
                            duration_minutes: category.duration_minutes,
                            category_name: category.category_name,
                            icon_key: category.icon_key,
                        })),
                        employees: branchEmployees.map((employee) => ({
                            id: employee.id.toString(),
                            user_id: employee.user_id.toString(),
                            branch_id: employee.branch_id.toString(),
                            email: employee.email,
                            name: employee.name,
                            lastname_p: employee.lastname_p,
                            role: employee.role,
                            can_attend: employee.can_attend,
                            active: employee.active,
                        })),
                    };
                }),
            );
        }

        const managerName = [row.manager_name, row.manager_lastname_p, row.manager_lastname_m]
            .filter(Boolean)
            .join(' ');
        const businessName = row.business_name ?? 'Sin nombre';

        return {
            id: row.application_id.toString(),
            state: row.state,
            supplier_type: row.supplier_type,
            application_date: row.application_date,
            business_name: businessName,
            manager_name: managerName,
            email: row.email,
            documents_pending: pending.count,
            comments: row.comments,
            rfc: row.rfc,
            business: row.business_id
                ? {
                    name: row.business_name,
                    tax_identification: row.business_tax_identification,
                    email: row.business_email,
                    phone: row.business_phone,
                }
                : null,
            branches: branchData,
            documents: docs.map((doc) => ({
                id: doc.id.toString(),
                type_document_id: doc.type_document_id.toString(),
                type_name: doc.type_name,
                file_key: doc.file_key,
                upload_date: doc.upload_date,
                due_date: doc.due_date,
                is_public: doc.is_public,
                validation: doc.validation,
            })),
        };
    }

    async getMyApplication(userIdInput: string) {
        const userId = parseId(userIdInput, 'user_id');
        const [supplier] = await db
            .select({ id: suppliers.UniqueID })
            .from(suppliers)
            .where(eq(suppliers.user_id, userId))
            .limit(1);

        if (!supplier) {
            throw new NotFoundError('No tienes una solicitud de proveedor registrada.', 'NOT_FOUND');
        }

        const [application] = await db
            .select({ id: supplier_applications.UniqueID })
            .from(supplier_applications)
            .where(eq(supplier_applications.supplier_id, supplier.id))
            .orderBy(desc(supplier_applications.application_date), desc(supplier_applications.UniqueID))
            .limit(1);

        if (!application) {
            throw new NotFoundError('No tienes una solicitud de proveedor registrada.', 'NOT_FOUND');
        }

        return this.getApplicationDetail(application.id.toString());
    }

    async listApplications(options: {
        state?: string;
        search?: string;
        page?: number;
        limit?: number;
    }) {
        const state = parseApplicationState(options.state);
        const page = options.page ?? 1;
        const limit = options.limit ?? 20;

        if (!Number.isInteger(page) || page < 1) {
            throw new BadRequestError(
                'El parámetro page debe ser un entero mayor o igual a 1.',
                'INVALID_PAGE',
            );
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new BadRequestError(
                'El parámetro limit debe ser un entero entre 1 y 100.',
                'INVALID_LIMIT',
            );
        }
        if (
            options.search !== undefined &&
            (typeof options.search !== 'string' || options.search.trim().length > 150)
        ) {
            throw new BadRequestError(
                'El parámetro search no puede superar los 150 caracteres.',
                'INVALID_SEARCH',
            );
        }

        const conditions = [];
        if (state) conditions.push(eq(supplier_applications.state, state));
        const search = options.search?.trim();
        if (search) {
            const pattern = `%${search}%`;
            conditions.push(
                or(
                    ilike(business.name, pattern),
                    ilike(
                        sql`concat_ws(' ', ${personal_data.name}, ${personal_data.lastname_p}, ${personal_data.lastname_m})`,
                        pattern,
                    ),
                    ilike(personal_data.name, pattern),
                    ilike(personal_data.lastname_p, pattern),
                    ilike(users.email, pattern),
                )!,
            );
        }
        const whereClause = conditions.length ? and(...conditions) : undefined;

        const countQuery = db
            .select({ total: countDistinct(supplier_applications.UniqueID) })
            .from(supplier_applications)
            .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
            .innerJoin(users, eq(suppliers.user_id, users.UniqueID))
            .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
            .leftJoin(
                business_supplier,
                and(
                    eq(suppliers.UniqueID, business_supplier.supplier_id),
                    eq(business_supplier.active, true),
                ),
            )
            .leftJoin(business, eq(business_supplier.business_id, business.UniqueID));
        const countRows = whereClause ? await countQuery.where(whereClause) : await countQuery;
        const total = Number(countRows[0]?.total ?? 0);

        const listQuery = db
            .select({
                id: supplier_applications.UniqueID,
                state: supplier_applications.state,
                supplier_type: supplier_applications.supplier_type,
                application_date: supplier_applications.application_date,
                supplier_id: suppliers.UniqueID,
                business_name: business.name,
                manager_name: personal_data.name,
                manager_lastname_p: personal_data.lastname_p,
                manager_lastname_m: personal_data.lastname_m,
                email: users.email,
            })
            .from(supplier_applications)
            .innerJoin(suppliers, eq(supplier_applications.supplier_id, suppliers.UniqueID))
            .innerJoin(users, eq(suppliers.user_id, users.UniqueID))
            .leftJoin(personal_data, eq(users.UniqueID, personal_data.user_id))
            .leftJoin(
                business_supplier,
                and(
                    eq(suppliers.UniqueID, business_supplier.supplier_id),
                    eq(business_supplier.active, true),
                ),
            )
            .leftJoin(business, eq(business_supplier.business_id, business.UniqueID));
        const rows = await (whereClause ? listQuery.where(whereClause) : listQuery)
            .orderBy(asc(supplier_applications.application_date), asc(supplier_applications.UniqueID))
            .limit(limit)
            .offset((page - 1) * limit);

        const data = await Promise.all(
            rows.map(async (row) => {
                const docs = await this.getDocuments(row.supplier_id);
                const pending = await this.getPendingDocumentInfo(row.supplier_id, row.supplier_type, docs);
                return {
                    id: row.id.toString(),
                    state: row.state,
                    supplier_type: row.supplier_type,
                    application_date: row.application_date,
                    business_name: row.business_name ?? 'Sin nombre',
                    manager_name: [row.manager_name, row.manager_lastname_p, row.manager_lastname_m]
                        .filter(Boolean)
                        .join(' '),
                    email: row.email,
                    documents_pending: pending.count,
                };
            }),
        );

        return {
            data,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
            },
        };
    }

    async reviewDocument(input: {
        documentId: string;
        reviewedBy: string;
        result: string;
        comment?: unknown;
    }) {
        const documentId = parseId(input.documentId, 'id');
        const reviewerId = parseId(input.reviewedBy, 'reviewed_by');

        if (input.result !== 'aprobado' && input.result !== 'rechazado') {
            throw new BadRequestError(
                'El resultado debe ser aprobado o rechazado.',
                'INVALID_DOCUMENT_RESULT',
            );
        }
        const result = input.result as DocumentResult;
        const comment = normalizeComment(input.comment, result === 'rechazado', 1000);

        const [document] = await db
            .select({
                id: supplier_documents.UniqueID,
                supplier_id: suppliers.UniqueID,
                user_id: users.UniqueID,
                supplier_type: suppliers.supplier_type,
                type_name: type_documents.name,
                application_state: supplier_applications.state,
            })
            .from(supplier_documents)
            .innerJoin(suppliers, eq(supplier_documents.supplier_id, suppliers.UniqueID))
            .innerJoin(users, eq(suppliers.user_id, users.UniqueID))
            .innerJoin(type_documents, eq(supplier_documents.type_document_id, type_documents.UniqueID))
            .innerJoin(supplier_applications, eq(supplier_applications.supplier_id, suppliers.UniqueID))
            .where(eq(supplier_documents.UniqueID, documentId))
            .orderBy(desc(supplier_applications.application_date), desc(supplier_applications.UniqueID))
            .limit(1);

        if (!document)
            throw new NotFoundError('No se encontró el documento del proveedor.', 'NOT_FOUND');
        if (document.application_state === 'aprobada' || document.application_state === 'rechazada') {
            throw new ConflictError(
                'La solicitud ya fue resuelta y no admite cambios en sus documentos.',
                'APPLICATION_ALREADY_RESOLVED',
            );
        }

        const dispatch = await eventBus.notify(
            new SupplierVerificationEvent({
                supplierId: document.supplier_id.toString(),
                userId: document.user_id.toString(),
                documentId: document.id.toString(),
                documentName: document.type_name,
                result,
                reviewedBy: reviewerId.toString(),
                comment,
                supplierType: document.supplier_type,
            }),
        );

        const historyFailure = dispatch.errors.find(
            (entry) => entry.observerName === 'HistoryObserver',
        );
        if (historyFailure) {
            throw new AppError(
                'No fue posible guardar la revisión del documento.',
                500,
                'DOCUMENT_REVIEW_FAILED',
            );
        }

        const docs = await this.getDocuments(document.supplier_id);
        const reviewed = docs.find((doc) => doc.id === document.id);
        if (!reviewed)
            throw new NotFoundError('No se encontró el documento después de la revisión.', 'NOT_FOUND');

        return {
            id: reviewed.id.toString(),
            type_document_id: reviewed.type_document_id.toString(),
            type_name: reviewed.type_name,
            file_key: reviewed.file_key,
            upload_date: reviewed.upload_date,
            due_date: reviewed.due_date,
            is_public: reviewed.is_public,
            validation: reviewed.validation,
        };
    }

    async resolveApplication(input: {
        applicationId: string;
        reviewedBy: string;
        state: string;
        comments?: unknown;
    }) {
        const applicationId = parseId(input.applicationId);
        const reviewerId = parseId(input.reviewedBy, 'reviewed_by');
        const targetState = parseApplicationState(input.state);

        if (!targetState || targetState === 'pendiente') {
            throw new BadRequestError(
                'La resolución debe ser aprobada, rechazada o documentacion_incompleta.',
                'INVALID_RESOLUTION',
            );
        }

        const comments = normalizeComment(input.comments, targetState !== 'aprobada', 2000);
        const row = await this.getApplicationBase(applicationId);

        if (row.state !== 'pendiente') {
            throw new ConflictError(
                'La solicitud ya fue resuelta o no está disponible para revisión.',
                'APPLICATION_ALREADY_RESOLVED',
            );
        }

        const docs = await this.getDocuments(row.supplier_id);
        const pending = await this.getPendingDocumentInfo(row.supplier_id, row.supplier_type, docs);
        if (targetState === 'aprobada' && pending.count > 0) {
            throw new ConflictError(
                'No se puede aprobar la solicitud porque hay documentos faltantes o sin aprobar.',
                'DOCUMENTS_PENDING',
            );
        }

        await db.transaction(async (tx) => {
            const [updated] = await tx
                .update(supplier_applications)
                .set({
                    state: targetState,
                    comments,
                    reviewed_by: reviewerId,
                })
                .where(
                    and(
                        eq(supplier_applications.UniqueID, applicationId),
                        eq(supplier_applications.state, 'pendiente'),
                    ),
                )
                .returning({ id: supplier_applications.UniqueID });

            if (!updated) {
                throw new ConflictError(
                    'La solicitud ya fue resuelta por otro administrador.',
                    'APPLICATION_ALREADY_RESOLVED',
                );
            }

            if (targetState === 'aprobada') {
                await tx
                    .update(users)
                    .set({ state: 'activo' })
                    .where(eq(users.UniqueID, row.supplier_user_id));
                await tx
                    .update(suppliers)
                    .set({ active: true })
                    .where(eq(suppliers.UniqueID, row.supplier_id));
            }
        });

        const managerName = [row.manager_name, row.manager_lastname_p, row.manager_lastname_m]
            .filter(Boolean)
            .join(' ');

        // El observador de correo procesa el resultado sin acoplar Resend a este servicio.
        await eventBus.notify(
            new SupplierApplicationResolvedEvent({
                applicationId: row.application_id.toString(),
                supplierId: row.supplier_id.toString(),
                userId: row.supplier_user_id.toString(),
                email: row.email,
                managerName,
                businessName: row.business_name ?? 'tu negocio',
                state: targetState,
                comments,
                missingDocuments: targetState === 'documentacion_incompleta' ? pending.names : [],
                reviewedBy: reviewerId.toString(),
            }),
        );

        return this.getApplicationDetail(applicationId.toString());
    }
}

export const adminSupplierApplicationService = new AdminSupplierApplicationService();
