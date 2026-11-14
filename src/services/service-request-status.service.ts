import { and, asc, desc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
    address_user,
    addresses,
    branches,
    branches_categories,
    business_supplier,
    categories,
    employees,
    employee_profiles,
    personal_data,
    request_attachments,
    request_dispatches,
    reviews,
    roles,
    service_request_events,
    service_requests,
    suppliers,
    users,
} from '../database/schema/tables.ts';
import {
    AppError,
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { ServiceRequestStatusChangedEvent } from '../events/events/domain-events.ts';
import { storageService } from './storage.service.ts';
import { isValidServiceRequestTransition } from '../utils/service-request-transitions.ts';

export const PUBLIC_STATUSES = [
    'pendiente',
    'aceptada',
    'agendada',
    'en_camino',
    'llegado',
    'completada',
    'cancelada',
    'expirada',
] as const;

type PublicStatus = (typeof PUBLIC_STATUSES)[number];

type DbStatus = (typeof service_requests.$inferSelect)['status'];

interface RequestActor {
    id: string;
    role: string;
}

interface AccessScope {
    condition: SQL;
    employeeIds: bigint[];
}

interface StatusChangeInput {
    status: PublicStatus;
    latitude: number;
    longitude: number;
    closing_keys: string[];
}

function parseBigintId(value: string): bigint {
    if (!/^[1-9]\d{0,17}$/.test(value)) {
        throw new BadRequestError('El identificador de solicitud no es válido.', 'INVALID_ID');
    }
    return BigInt(value);
}

function publicStatus(status: string): string {
    // Compatibilidad de registros antiguos creados antes de separar En camino y Llegado.
    return status === 'en_curso' ? 'en_camino' : status;
}

function parseStatus(value: unknown): PublicStatus | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !PUBLIC_STATUSES.includes(value as PublicStatus)) {
        throw new BadRequestError(
            `El estado debe ser uno de: ${PUBLIC_STATUSES.join(', ')}.`,
            'VALIDATION_ERROR',
        );
    }
    return value as PublicStatus;
}

function parsePagination(pageValue: unknown, limitValue: unknown) {
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isInteger(page) || page < 1) {
        throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new BadRequestError('limit debe ser un entero entre 1 y 100.', 'VALIDATION_ERROR');
    }
    return { page, limit };
}

function validateStatusChange(input: unknown): StatusChangeInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new BadRequestError('Los datos enviados no son válidos.', 'VALIDATION_ERROR');
    }
    const body = input as Record<string, unknown>;
    const details: Array<{ field: string; message: string }> = [];
    const allowed = ['status', 'latitude', 'longitude', 'closing_keys'];
    for (const field of Object.keys(body)) {
        if (!allowed.includes(field))
            details.push({ field, message: `El campo ${field} no está permitido.` });
    }

    const status = parseStatus(body.status);
    if (!status || !['en_camino', 'llegado', 'completada'].includes(status)) {
        details.push({
            field: 'status',
            message: 'El estado debe ser en_camino, llegado o completada.',
        });
    }

    const latitude = body.latitude;
    const longitude = body.longitude;
    if (
        typeof latitude !== 'number' ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90
    ) {
        details.push({ field: 'latitude', message: 'La latitud debe ser un número entre -90 y 90.' });
    }
    if (
        typeof longitude !== 'number' ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
    ) {
        details.push({
            field: 'longitude',
            message: 'La longitud debe ser un número entre -180 y 180.',
        });
    }

    let closingKeys: string[] = [];
    if (body.closing_keys !== undefined) {
        if (
            !Array.isArray(body.closing_keys) ||
            body.closing_keys.length > 5 ||
            body.closing_keys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)
        ) {
            details.push({
                field: 'closing_keys',
                message: 'Debe ser una lista de hasta 5 llaves de archivo válidas.',
            });
        } else {
            closingKeys = body.closing_keys.map((key) => (key as string).trim());
        }
    }

    if (status === 'completada' && closingKeys.length === 0) {
        // Las evidencias son opcionales en el contrato actual.
    }
    if (status !== 'completada' && closingKeys.length > 0) {
        details.push({
            field: 'closing_keys',
            message: 'Las evidencias de cierre solo se permiten al completar el servicio.',
        });
    }

    if (details.length) {
        const error = new AppError(
            'Los datos enviados no son válidos.',
            400,
            'VALIDATION_ERROR',
        ) as AppError & { details?: unknown };
        error.details = details;
        throw error;
    }

    return {
        status: status as PublicStatus,
        latitude: latitude as number,
        longitude: longitude as number,
        closing_keys: closingKeys,
    };
}

async function getAccessScope(actor: RequestActor): Promise<AccessScope> {
    const actorId = BigInt(actor.id);
    const role = actor.role.trim().toLowerCase();

    if (role === 'cliente') {
        return { condition: eq(service_requests.client_id, actorId), employeeIds: [] };
    }

    if (role === 'proveedor') {
        const ownedBranches = await db
            .select({ id: branches.UniqueID })
            .from(branches)
            .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
            .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
            .where(
                and(
                    eq(suppliers.user_id, actorId),
                    eq(suppliers.active, true),
                    eq(business_supplier.active, true),
                ),
            );
        const branchIds = ownedBranches.map((branch) => branch.id);
        return {
            condition: branchIds.length ? inArray(service_requests.branch_id, branchIds) : sql`false`,
            employeeIds: [],
        };
    }

    if (role === 'gerente' || role === 'empleado') {
        const assignments = await db
            .select({ id: employees.UniqueID, branchId: employees.branch_id })
            .from(employees)
            .where(and(eq(employees.user_id, actorId), eq(employees.active, true)));
        const employeeIds = assignments.map((assignment) => assignment.id);
        const branchIds = [
            ...new Set(assignments.map((assignment) => assignment.branchId.toString())),
        ].map((value) => BigInt(value));

        if (role === 'gerente') {
            return {
                condition: branchIds.length ? inArray(service_requests.branch_id, branchIds) : sql`false`,
                employeeIds,
            };
        }

        if (!employeeIds.length) return { condition: sql`false`, employeeIds };
        const dispatchMatch = exists(
            db
                .select({ id: request_dispatches.UniqueID })
                .from(request_dispatches)
                .where(
                    and(
                        eq(request_dispatches.request_id, service_requests.UniqueID),
                        inArray(request_dispatches.employee_id, employeeIds),
                    ),
                ),
        );
        return {
            condition: or(inArray(service_requests.employee_id, employeeIds), dispatchMatch)!,
            employeeIds,
        };
    }

    throw new ForbiddenError(
        'No tienes permisos para consultar solicitudes de servicio.',
        'INSUFFICIENT_PERMISSIONS',
    );
}

function normalizeNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function signedFileUrl(fileKey: string | null | undefined): string | null {
    if (!fileKey) return null;
    try {
        return storageService.generateSignedUrl({ file_key: fileKey }).signed_url;
    } catch {
        return null;
    }
}

async function serializeRequest(requestId: bigint) {
    const [request] = await db
        .select()
        .from(service_requests)
        .where(eq(service_requests.UniqueID, requestId))
        .limit(1);
    if (!request) throw new NotFoundError();

    const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.UniqueID, request.category_id))
        .limit(1);
    const [branch] = await db
        .select()
        .from(branches)
        .where(eq(branches.UniqueID, request.branch_id))
        .limit(1);
    const [addressRow] = await db
        .select({ address: addresses, alias: address_user.alias, isMain: address_user.is_main })
        .from(addresses)
        .leftJoin(
            address_user,
            and(
                eq(address_user.address_id, addresses.UniqueID),
                eq(address_user.user_id, request.client_id),
            ),
        )
        .where(eq(addresses.UniqueID, request.address_id))
        .limit(1);
    const [client] = await db
        .select()
        .from(personal_data)
        .where(eq(personal_data.user_id, request.client_id))
        .limit(1);
    const [rating] = await db
        .select({ average: sql<string | null>`avg(${reviews.rating})` })
        .from(reviews)
        .where(
            and(
                eq(reviews.reviewee_id, request.client_id),
                eq(reviews.direction, 'proveedor_a_cliente'),
                eq(reviews.status, 'publicada'),
            ),
        );
    const [price] = await db
        .select({ amount: branches_categories.base_price })
        .from(branches_categories)
        .where(
            and(
                eq(branches_categories.branch_id, request.branch_id),
                eq(branches_categories.category_id, request.category_id),
                eq(branches_categories.active, true),
            ),
        )
        .limit(1);

    let technician: { employee_id: string; name: string; photo_url: string | null } | null = null;
    if (request.employee_id) {
        const [employee] = await db
            .select({ employeeId: employees.UniqueID, userId: employees.user_id })
            .from(employees)
            .where(eq(employees.UniqueID, request.employee_id))
            .limit(1);
        if (employee) {
            const [technicianData] = await db
                .select()
                .from(personal_data)
                .where(eq(personal_data.user_id, employee.userId))
                .limit(1);
            const [profile] = await db
                .select()
                .from(employee_profiles)
                .where(eq(employee_profiles.employee_id, employee.employeeId))
                .limit(1);
            technician = {
                employee_id: employee.employeeId.toString(),
                name: technicianData ? `${technicianData.name} ${technicianData.lastname_p}`.trim() : '',
                photo_url: signedFileUrl(profile?.photo_key),
            };
        }
    }

    const attachments = await db
        .select()
        .from(request_attachments)
        .where(eq(request_attachments.request_id, requestId))
        .orderBy(asc(request_attachments.created_at));
    const address = addressRow?.address;

    return {
        id: request.UniqueID.toString(),
        status: publicStatus(request.status),
        is_emergency: request.is_emergency,
        description: request.description,
        category: category ? { id: category.UniqueID.toString(), name: category.name } : null,
        branch: branch
            ? { id: branch.UniqueID.toString(), name: branch.name, phone: branch.phone }
            : null,
        technician,
        client: {
            name: client ? `${client.name} ${client.lastname_p}`.trim() : '',
            rating_avg: normalizeNumber(rating?.average) ?? 0,
        },
        address: address
            ? {
                id: address.UniqueID.toString(),
                alias: addressRow?.alias ?? null,
                reference: address.reference,
                street: address.street,
                num_ext: address.num_ext,
                num_int: address.num_int,
                colony: address.colony,
                municipality: address.municipality,
                state: address.state,
                postal_code: address.postal_code,
                country: address.country,
                latitude: normalizeNumber(address.latitude),
                longitude: normalizeNumber(address.longitude),
                is_main: addressRow?.isMain ?? false,
            }
            : null,
        base_price: price?.amount ?? null,
        agreed_price: request.agreed_price,
        attachments: attachments.map((attachment) => ({
            file_key: attachment.file_key,
            mime_type: attachment.mime_type,
            size_bytes: attachment.size_bytes,
            url: signedFileUrl(attachment.file_key),
        })),
        created_at: request.created_at,
        expires_at: request.expires_at,
        scheduled_at: request.scheduled_at,
        accepted_at: request.accepted_at,
        arrived_at: request.arrived_at,
        completed_at: request.completed_at,
        canceled_by: request.canceled_by,
        canceled_reason: request.canceled_reason,
    };
}

export async function listServiceRequests(
    actor: RequestActor,
    query: { status?: unknown; page?: unknown; limit?: unknown },
) {
    const status = parseStatus(query.status);
    const { page, limit } = parsePagination(query.page, query.limit);
    const scope = await getAccessScope(actor);
    const filters: SQL[] = [scope.condition];
    if (status) {
        if (status === 'en_camino') {
            filters.push(
                or(eq(service_requests.status, 'en_camino'), eq(service_requests.status, 'en_curso'))!,
            );
        } else {
            filters.push(eq(service_requests.status, status as DbStatus));
        }
    }
    const where = and(...filters);
    const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(service_requests)
        .where(where);
    const rows = await db
        .select({ id: service_requests.UniqueID })
        .from(service_requests)
        .where(where)
        .orderBy(desc(service_requests.created_at), desc(service_requests.UniqueID))
        .limit(limit)
        .offset((page - 1) * limit);

    return {
        data: await Promise.all(rows.map((row) => serializeRequest(row.id))),
        pagination: {
            page,
            limit,
            total: Number(countRow?.total ?? 0),
            total_pages: Math.ceil(Number(countRow?.total ?? 0) / limit),
        },
    };
}

async function ensureRequestVisible(
    requestId: bigint,
    actor: RequestActor,
): Promise<typeof service_requests.$inferSelect> {
    const scope = await getAccessScope(actor);
    const [request] = await db
        .select()
        .from(service_requests)
        .where(and(eq(service_requests.UniqueID, requestId), scope.condition))
        .limit(1);
    if (!request) throw new NotFoundError();
    return request;
}

export async function getServiceRequest(requestId: bigint, actor: RequestActor) {
    await ensureRequestVisible(requestId, actor);
    return serializeRequest(requestId);
}

export async function getServiceRequestEvents(requestId: bigint, actor: RequestActor) {
    await ensureRequestVisible(requestId, actor);
    const rows = await db
        .select({
            fromStatus: service_request_events.from_status,
            toStatus: service_request_events.to_status,
            changedById: users.UniqueID,
            changedByRole: roles.name,
            latitude: service_request_events.latitude,
            longitude: service_request_events.longitude,
            createdAt: service_request_events.created_at,
            eventId: service_request_events.UniqueID,
        })
        .from(service_request_events)
        .innerJoin(users, eq(service_request_events.changed_by, users.UniqueID))
        .leftJoin(roles, eq(users.role_id, roles.UniqueID))
        .where(eq(service_request_events.request_id, requestId))
        .orderBy(asc(service_request_events.created_at), asc(service_request_events.UniqueID));

    return rows.map((row) => ({
        from_status: row.fromStatus ? publicStatus(row.fromStatus) : null,
        to_status: publicStatus(row.toStatus),
        changed_by: { id: row.changedById.toString(), role: row.changedByRole ?? 'desconocido' },
        latitude: normalizeNumber(row.latitude),
        longitude: normalizeNumber(row.longitude),
        created_at: row.createdAt,
    }));
}

export async function advanceServiceRequestStatus(
    requestId: bigint,
    actor: RequestActor,
    rawInput: unknown,
) {
    const input = validateStatusChange(rawInput);
    if (actor.role.trim().toLowerCase() !== 'empleado') {
        throw new ForbiddenError(
            'Solo el técnico asignado puede avanzar el estado de la solicitud.',
            'INSUFFICIENT_PERMISSIONS',
        );
    }

    const actorId = BigInt(actor.id);
    const target = input.status;
    const now = new Date();
    let updatedRequest: typeof service_requests.$inferSelect | null = null;
    let fromStatus = '';

    await db.transaction(async (tx) => {
        const [current] = await tx
            .select()
            .from(service_requests)
            .where(eq(service_requests.UniqueID, requestId))
            .for('update')
            .limit(1);
        if (!current) throw new NotFoundError();
        if (!current.employee_id)
            throw new ForbiddenError(
                'La solicitud todavía no está asignada a un técnico.',
                'INSUFFICIENT_PERMISSIONS',
            );

        const [assignment] = await tx
            .select({ id: employees.UniqueID })
            .from(employees)
            .where(
                and(
                    eq(employees.UniqueID, current.employee_id),
                    eq(employees.user_id, actorId),
                    eq(employees.active, true),
                ),
            )
            .limit(1);
        if (!assignment) throw new NotFoundError();

        const currentStatus = publicStatus(current.status);
        if (!isValidServiceRequestTransition(currentStatus, target)) {
            throw new ConflictError(
                `No se permite cambiar el estado de ${currentStatus} a ${target}.`,
                'INVALID_STATUS_TRANSITION',
            );
        }

        const dbTarget = target as DbStatus;
        const [updated] = await tx
            .update(service_requests)
            .set({
                status: dbTarget,
                ...(target === 'en_camino' ? { expires_at: null } : {}),
                ...(target === 'llegado' ? { arrived_at: now } : {}),
                ...(target === 'completada' ? { completed_at: now } : {}),
            })
            .where(eq(service_requests.UniqueID, requestId))
            .returning();
        if (!updated) throw new NotFoundError();

        await tx.insert(service_request_events).values({
            request_id: requestId,
            from_status: current.status,
            to_status: dbTarget,
            changed_by: actorId,
            latitude: String(input.latitude),
            longitude: String(input.longitude),
            created_at: now,
        });

        if (input.closing_keys.length) {
            await tx.insert(request_attachments).values(
                input.closing_keys.map((fileKey) => ({
                    request_id: requestId,
                    file_key: fileKey,
                    mime_type: 'other' as const,
                    kind: 'cierre_servicio' as const,
                })),
            );
        }

        updatedRequest = updated;
        fromStatus = currentStatus;
    });

    const event = new ServiceRequestStatusChangedEvent({
        requestId: requestId.toString(),
        fromStatus: fromStatus!,
        toStatus: target,
        changedBy: actor.id,
        clientId: updatedRequest!.client_id.toString(),
        employeeId: updatedRequest!.employee_id?.toString() ?? null,
        branchId: updatedRequest!.branch_id.toString(),
        latitude: input.latitude,
        longitude: input.longitude,
        historyPersisted: true,
    });
    await eventBus.notify(event);

    return serializeRequest(requestId);
}
