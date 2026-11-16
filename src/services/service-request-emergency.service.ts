import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
    addresses,
    branches,
    branches_categories,
    branch_schedules,
    business_supplier,
    categories,
    employees,
    request_dispatches,
    roles,
    service_request_events,
    service_requests,
    suppliers,
    users,
} from '../database/schema/tables.ts';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import {
    ServiceRequestDispatchedEvent,
    ServiceRequestStatusChangedEvent,
} from '../events/events/domain-events.ts';
import { getServiceRequest } from './service-request-status.service.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { timerService } from './timer.service.ts';

const EMERGENCY_RADIUS_KM = 10;
const EMERGENCY_EXPIRATION_MINUTES = 5;
const ACTIVE_REQUEST_STATUSES = [
    'pendiente',
    'aceptada',
    'agendada',
    'en_curso',
    'en_camino',
    'llegado',
] as const;

interface EmergencyRequestInput {
    client_uuid: string;
    category_id: bigint;
    latitude: number;
    longitude: number;
    description: string;
}

interface EmergencyCandidate {
    employeeId: bigint;
    userId: bigint;
    branchId: bigint;
    latitude: number;
    longitude: number;
    timezone: string;
    supplierType: 'independiente' | 'empresa';
    rating: number;
}

function parseEmergencyInput(value: unknown): EmergencyRequestInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
    }

    const body = value as Record<string, unknown>;
    const allowed = ['client_uuid', 'category_id', 'latitude', 'longitude', 'description'];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) {
        throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
    }

    if (
        typeof body.client_uuid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            body.client_uuid,
        )
    ) {
        throw new BadRequestError('client_uuid debe ser un UUID válido.', 'VALIDATION_ERROR');
    }

    if (typeof body.category_id !== 'string' || !/^[1-9]\d{0,17}$/.test(body.category_id)) {
        throw new BadRequestError('category_id debe ser un identificador válido.', 'VALIDATION_ERROR');
    }

    if (
        typeof body.latitude !== 'number' ||
        !Number.isFinite(body.latitude) ||
        body.latitude < -90 ||
        body.latitude > 90
    ) {
        throw new BadRequestError('latitude debe ser un número entre -90 y 90.', 'VALIDATION_ERROR');
    }

    if (
        typeof body.longitude !== 'number' ||
        !Number.isFinite(body.longitude) ||
        body.longitude < -180 ||
        body.longitude > 180
    ) {
        throw new BadRequestError('longitude debe ser un número entre -180 y 180.', 'VALIDATION_ERROR');
    }

    let description = 'Solicitud de emergencia';
    if (body.description !== undefined) {
        if (typeof body.description !== 'string' || body.description.trim().length > 500) {
            throw new BadRequestError(
                'description debe ser texto y no exceder 500 caracteres.',
                'VALIDATION_ERROR',
            );
        }
        description = body.description.trim() || description;
    }

    return {
        client_uuid: body.client_uuid,
        category_id: BigInt(body.category_id),
        latitude: body.latitude,
        longitude: body.longitude,
        description,
    };
}

function distanceInKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const earthRadiusKm = 6371;
    const latitudeDelta = toRadians(lat2 - lat1);
    const longitudeDelta = toRadians(lon2 - lon1);
    const a =
        Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLocalScheduleParts(date: Date, timeZone: string) {
    try {
        const parts = Object.fromEntries(
            new Intl.DateTimeFormat('en-US', {
                timeZone,
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            })
                .formatToParts(date)
                .map((part) => [part.type, part.value]),
        );
        const weekdays: Record<string, number> = {
            Sun: 0,
            Mon: 1,
            Tue: 2,
            Wed: 3,
            Thu: 4,
            Fri: 5,
            Sat: 6,
        };
        return {
            dayOfWeek: weekdays[parts.weekday!]!,
            time: `${parts.hour}:${parts.minute}`,
        };
    } catch {
        return null;
    }
}

async function findNearbyAvailableTechnicians(
    categoryId: bigint,
    latitude: number,
    longitude: number,
): Promise<EmergencyCandidate[]> {
    const rows = await db
        .select({
            employeeId: employees.UniqueID,
            userId: users.UniqueID,
            branchId: branches.UniqueID,
            latitude: addresses.latitude,
            longitude: addresses.longitude,
            timezone: branches.timezone,
            supplierType: suppliers.supplier_type,
            rating: branches.rating_avg,
        })
        .from(employees)
        .innerJoin(users, eq(employees.user_id, users.UniqueID))
        .innerJoin(roles, eq(users.role_id, roles.UniqueID))
        .innerJoin(branches, eq(employees.branch_id, branches.UniqueID))
        .innerJoin(addresses, eq(branches.address_id, addresses.UniqueID))
        .innerJoin(branches_categories, eq(branches_categories.branch_id, branches.UniqueID))
        .innerJoin(categories, eq(branches_categories.category_id, categories.UniqueID))
        .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
        .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
        .where(
            and(
                eq(employees.active, true),
                eq(employees.can_attend, true),
                eq(users.state, 'activo'),
                eq(roles.name, 'empleado'),
                eq(roles.active, true),
                eq(branches.accepting_request, true),
                eq(branches_categories.active, true),
                eq(categories.active, true),
                eq(categories.UniqueID, categoryId),
                eq(business_supplier.active, true),
                eq(suppliers.active, true),
                sql`${addresses.latitude} IS NOT NULL`,
                sql`${addresses.longitude} IS NOT NULL`,
            ),
        );

    const uniqueCandidates = new Map<string, EmergencyCandidate>();
    for (const row of rows) {
        if (row.latitude === null || row.longitude === null) continue;
        const branchLatitude = Number(row.latitude);
        const branchLongitude = Number(row.longitude);
        if (!Number.isFinite(branchLatitude) || !Number.isFinite(branchLongitude)) continue;

        const distance = distanceInKm(latitude, longitude, branchLatitude, branchLongitude);
        if (distance > EMERGENCY_RADIUS_KM) continue;

        const candidate: EmergencyCandidate = {
            employeeId: row.employeeId,
            userId: row.userId,
            branchId: row.branchId,
            latitude: branchLatitude,
            longitude: branchLongitude,
            timezone: row.timezone,
            supplierType: row.supplierType,
            rating: Number(row.rating ?? 0),
        };

        const key = row.employeeId.toString();
        const current = uniqueCandidates.get(key);
        if (
            !current ||
            (candidate.supplierType === 'independiente' && current.supplierType !== 'independiente')
        ) {
            uniqueCandidates.set(key, candidate);
        }
    }

    const candidates = [...uniqueCandidates.values()];
    if (!candidates.length) return [];

    const branchIds = [...new Set(candidates.map((candidate) => candidate.branchId))];
    const schedules = await db
        .select({
            branchId: branch_schedules.branch_id,
            dayOfWeek: branch_schedules.day_of_week,
            openTime: branch_schedules.open_time,
            closeTime: branch_schedules.close_time,
        })
        .from(branch_schedules)
        .where(and(inArray(branch_schedules.branch_id, branchIds), eq(branch_schedules.active, true)));

    const now = new Date();
    const openBranchIds = new Set<bigint>();
    for (const candidate of candidates) {
        const local = getLocalScheduleParts(now, candidate.timezone);
        if (!local) continue;
        const isOpen = schedules.some(
            (schedule) =>
                schedule.branchId === candidate.branchId &&
                schedule.dayOfWeek === local.dayOfWeek &&
                local.time >= schedule.openTime.slice(0, 5) &&
                local.time < schedule.closeTime.slice(0, 5),
        );
        if (isOpen) openBranchIds.add(candidate.branchId);
    }

    const openCandidates = candidates.filter((candidate) => openBranchIds.has(candidate.branchId));
    if (!openCandidates.length) return [];

    const employeeIds = openCandidates.map((candidate) => candidate.employeeId);
    const busyAssignments = await db
        .select({ employeeId: service_requests.employee_id })
        .from(service_requests)
        .where(
            and(
                inArray(service_requests.employee_id, employeeIds),
                inArray(service_requests.status, [...ACTIVE_REQUEST_STATUSES]),
            ),
        );

    const busyDispatches = await db
        .select({ employeeId: request_dispatches.employee_id })
        .from(request_dispatches)
        .innerJoin(service_requests, eq(request_dispatches.request_id, service_requests.UniqueID))
        .where(
            and(
                inArray(request_dispatches.employee_id, employeeIds),
                eq(service_requests.status, 'pendiente'),
                isNull(request_dispatches.response),
            ),
        );

    const busyEmployeeIds = new Set(
        [...busyAssignments, ...busyDispatches]
            .map((row) => row.employeeId?.toString())
            .filter((id): id is string => Boolean(id)),
    );

    return openCandidates
        .filter((candidate) => !busyEmployeeIds.has(candidate.employeeId.toString()))
        .sort((a, b) => {
            if (a.supplierType !== b.supplierType) {
                return a.supplierType === 'independiente' ? -1 : 1;
            }
            if (a.rating !== b.rating) return b.rating - a.rating;
            return (
                distanceInKm(latitude, longitude, a.latitude, a.longitude) -
                distanceInKm(latitude, longitude, b.latitude, b.longitude)
            );
        });
}

export async function createEmergencyServiceRequest(
    actor: { id: string; role: string },
    rawInput: unknown,
) {
    if (actor.role.trim().toLowerCase() !== 'cliente') {
        throw new ForbiddenError(
            'Solo un cliente puede crear solicitudes de emergencia.',
            'INSUFFICIENT_PERMISSIONS',
        );
    }

    const input = parseEmergencyInput(rawInput);
    const clientId = BigInt(actor.id);

    const [existing] = await db
        .select({ id: service_requests.UniqueID })
        .from(service_requests)
        .where(
            and(
                eq(service_requests.client_id, clientId),
                eq(service_requests.client_uuid, input.client_uuid),
            ),
        )
        .limit(1);
    if (existing) return await getServiceRequest(existing.id, actor);

    const [category] = await db
        .select({ id: categories.UniqueID, name: categories.name })
        .from(categories)
        .where(and(eq(categories.UniqueID, input.category_id), eq(categories.active, true)))
        .limit(1);
    if (!category) throw new NotFoundError('La categoría no existe o no está disponible.');

    const candidates = await findNearbyAvailableTechnicians(
        input.category_id,
        input.latitude,
        input.longitude,
    );
    if (!candidates.length) {
        throw new ConflictError(
            'No hay técnicos disponibles cerca para esta categoría.',
            'NO_TECHNICIANS_AVAILABLE',
        );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EMERGENCY_EXPIRATION_MINUTES * 60_000);

    let requestId: bigint;
    try {
        requestId = await db.transaction(async (tx) => {
            const [request] = await tx
                .insert(service_requests)
                .values({
                    client_id: clientId,
                    category_id: input.category_id,
                    branch_id: null,
                    address_id: null,
                    latitude: String(input.latitude),
                    longitude: String(input.longitude),
                    employee_id: null,
                    is_emergency: true,
                    description: input.description,
                    status: 'pendiente',
                    expires_at: expiresAt,
                    agreed_price: null,
                    client_uuid: input.client_uuid,
                    scheduled_at: null,
                    scheduled_end: null,
                    created_at: now,
                })
                .returning({ id: service_requests.UniqueID });

            const id = request!.id;
            await tx.insert(request_dispatches).values(
                candidates.map((candidate) => ({
                    request_id: id,
                    employee_id: candidate.employeeId,
                    notified_at: now,
                    responded_at: null,
                    response: null,
                })),
            );
            await tx.insert(service_request_events).values({
                request_id: id,
                from_status: null,
                to_status: 'pendiente',
                changed_by: clientId,
                created_at: now,
            });
            return id;
        });
    } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code === '23505' && databaseError.constraint?.includes('client_uuid')) {
            const [duplicate] = await db
                .select({ id: service_requests.UniqueID })
                .from(service_requests)
                .where(
                    and(
                        eq(service_requests.client_id, clientId),
                        eq(service_requests.client_uuid, input.client_uuid),
                    ),
                )
                .limit(1);
            if (duplicate) return await getServiceRequest(duplicate.id, actor);
        }
        throw error;
    }

    try {
        await timerService.start(redisKeys.requestTimer(requestId), EMERGENCY_EXPIRATION_MINUTES * 60);
    } catch (error) {
        // expires_at persiste en PostgreSQL; el worker API-29 recupera el vencimiento aunque Redis no esté disponible.
        console.error('[API-29] No se pudo iniciar el temporizador Redis de emergencia:', error);
    }

    const recipientUserIds = [...new Set(candidates.map((candidate) => candidate.userId.toString()))];
    await eventBus.notify(
        new ServiceRequestStatusChangedEvent({
            requestId: requestId.toString(),
            fromStatus: null,
            toStatus: 'pendiente',
            changedBy: actor.id,
            clientId: actor.id,
            employeeId: null,
            branchId: null,
            latitude: input.latitude,
            longitude: input.longitude,
            historyPersisted: true,
        }),
    );
    await eventBus.notify(
        new ServiceRequestDispatchedEvent({
            requestId: requestId.toString(),
            categoryId: input.category_id.toString(),
            categoryName: category.name,
            latitude: input.latitude,
            longitude: input.longitude,
            recipientUserIds,
            employeeIds: candidates.map((candidate) => candidate.employeeId.toString()),
            radiusKm: EMERGENCY_RADIUS_KM,
        }),
    );

    return await getServiceRequest(requestId, actor);
}
