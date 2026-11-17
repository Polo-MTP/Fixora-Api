import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
    branches,
    business_supplier,
    employees,
    request_attachments,
    request_dispatches,
    service_request_events,
    service_requests,
    suppliers,
} from '../database/schema/tables.ts';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { ServiceRequestStatusChangedEvent } from '../events/events/domain-events.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { storageService } from './storage.service.ts';
import { timerService } from './timer.service.ts';
import { serializeServiceRequestForResponse } from './service-request-status.service.ts';

interface Actor {
    id: string;
    role: string;
}

const ACTIVE_STATUSES_AFTER_ACCEPTANCE = [
    'aceptada',
    'agendada',
    'en_camino',
    'llegado',
] as const;
const ALLOWED_ATTACHMENT_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'video/mp4',
] as const;

function parseReason(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
        throw new BadRequestError(
            'Después de aceptar la solicitud debes proporcionar un motivo de cancelación de máximo 500 caracteres.',
            'CANCEL_REASON_REQUIRED',
        );
    }
    return value.trim();
}

function parseEvidenceKeys(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 5) {
        throw new BadRequestError(
            'evidence_keys debe ser un arreglo de hasta 5 llaves.',
            'INVALID_EVIDENCE_KEYS',
        );
    }
    const keys = value.map((key) => {
        if (typeof key !== 'string' || !key.trim() || key.length > 500) {
            throw new BadRequestError(
                'Cada elemento de evidence_keys debe ser una llave válida.',
                'INVALID_EVIDENCE_KEYS',
            );
        }
        return key.trim();
    });
    if (new Set(keys).size !== keys.length) {
        throw new BadRequestError(
            'No puedes enviar llaves de evidencia duplicadas.',
            'INVALID_EVIDENCE_KEYS',
        );
    }
    return keys;
}

async function validateEvidenceFiles(keys: string[], actorId: string) {
    const validated: Array<{
        file_key: string;
        mime_type: (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number] | 'other';
        size_bytes: number;
    }> = [];

    for (const key of keys) {
        if (!key.startsWith('evidences/') || storageService.getFileOwnerId(key) !== actorId) {
            throw new ForbiddenError(
                'Solo puedes adjuntar evidencias de cancelación que hayas subido previamente en la categoría evidences.',
                'EVIDENCE_FILE_NOT_OWNED',
            );
        }

        const file = await storageService.getFileForDownload(key);
        if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.mimeType as (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number])) {
            throw new BadRequestError(
                'El archivo de evidencia debe ser una imagen, PDF o video MP4.',
                'INVALID_EVIDENCE_FILE_TYPE',
            );
        }

        validated.push({
            file_key: key,
            mime_type: file.mimeType as (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number],
            size_bytes: file.sizeBytes,
        });
    }

    return validated;
}

export async function cancelServiceRequest(requestId: bigint, actor: Actor, rawBody: unknown) {
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
    }

    const body = rawBody as Record<string, unknown>;
    const unknown = Object.keys(body).filter((key) => !['reason', 'evidence_keys'].includes(key));
    if (unknown.length) {
        throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
    }

    const role = actor.role.trim().toLowerCase();
    const isClient = role === 'cliente';
    const isProvider = role === 'proveedor';
    const isEmployee = role === 'empleado';
    if (!isClient && !isProvider && !isEmployee) {
        throw new ForbiddenError(
            'Solo el cliente o el proveedor asignado puede cancelar la solicitud.',
            'INSUFFICIENT_PERMISSIONS',
        );
    }

    const evidenceKeys = parseEvidenceKeys(body.evidence_keys);
    if (isClient && evidenceKeys.length) {
        throw new BadRequestError('El cliente no puede adjuntar evidencia de cancelación.', 'EVIDENCE_NOT_ALLOWED');
    }

    const actorId = BigInt(actor.id);
    const now = new Date();
    const canceledBy: 'cliente' | 'proveedor' = isClient ? 'cliente' : 'proveedor';

    const cancellation = await db.transaction(async (tx) => {
        const [request] = await tx
            .select()
            .from(service_requests)
            .where(eq(service_requests.UniqueID, requestId))
            .for('update')
            .limit(1);

        if (!request) throw new NotFoundError();

        if (isClient && request.client_id !== actorId) throw new NotFoundError();

        let reason: string | null = null;
        let evidenceFiles: Awaited<ReturnType<typeof validateEvidenceFiles>> = [];

        if (isClient && request.accepted_at === null) {
            if (request.status !== 'pendiente') {
                throw new ConflictError(
                    'La solicitud ya no puede cancelarse en su estado actual.',
                    'INVALID_STATUS_TRANSITION',
                );
            }
        } else {
            if (
                !request.accepted_at ||
                !ACTIVE_STATUSES_AFTER_ACCEPTANCE.includes(
                    request.status as (typeof ACTIVE_STATUSES_AFTER_ACCEPTANCE)[number],
                )
            ) {
                throw new ConflictError(
                    'La solicitud no se encuentra en un estado que permita cancelación.',
                    'INVALID_STATUS_TRANSITION',
                );
            }
            reason = parseReason(body.reason);

            if (isProvider || isEmployee) {
                if (!request.employee_id || !request.branch_id) throw new NotFoundError();

                if (isEmployee) {
                    const [assignedEmployee] = await tx
                        .select({ id: employees.UniqueID })
                        .from(employees)
                        .where(
                            and(
                                eq(employees.UniqueID, request.employee_id),
                                eq(employees.user_id, actorId),
                                eq(employees.active, true),
                            ),
                        )
                        .limit(1);
                    if (!assignedEmployee) throw new NotFoundError('No eres el técnico asignado a esta solicitud.');
                } else {
                    const [ownedBranch] = await tx
                        .select({ id: branches.UniqueID })
                        .from(branches)
                        .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
                        .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
                        .where(
                            and(
                                eq(branches.UniqueID, request.branch_id),
                                eq(suppliers.user_id, actorId),
                                eq(suppliers.active, true),
                                eq(business_supplier.active, true),
                            ),
                        )
                        .limit(1);
                    if (!ownedBranch) throw new NotFoundError('La solicitud no pertenece a tu proveedor.');
                }

                evidenceFiles = await validateEvidenceFiles(evidenceKeys, actor.id);
            }
        }

        const [updated] = await tx
            .update(service_requests)
            .set({
                status: 'cancelada',
                canceled_by: canceledBy,
                canceled_reason: reason,
                expires_at: null,
            })
            .where(eq(service_requests.UniqueID, requestId))
            .returning({ id: service_requests.UniqueID });

        if (!updated) {
            throw new ConflictError('No fue posible cancelar la solicitud.', 'CANCELLATION_FAILED');
        }

        if (request.status === 'pendiente') {
            await tx
                .update(request_dispatches)
                .set({ response: 'retirado', responded_at: now })
                .where(
                    and(eq(request_dispatches.request_id, requestId), isNull(request_dispatches.response)),
                );
        }

        if (evidenceFiles.length) {
            await tx.insert(request_attachments).values(
                evidenceFiles.map((file) => ({
                    request_id: requestId,
                    file_key: file.file_key,
                    mime_type: file.mime_type,
                    size_bytes: file.size_bytes,
                    kind: 'evidencia_cancelacion' as const,
                })),
            );
        }

        await tx.insert(service_request_events).values({
            request_id: requestId,
            from_status: request.status,
            to_status: 'cancelada',
            changed_by: actorId,
            created_at: now,
        });

        return {
            fromStatus: request.status,
            clientId: request.client_id,
            employeeId: request.employee_id,
            branchId: request.branch_id,
            reason,
        };
    });

    try {
        await timerService.cancel(redisKeys.requestTimer(requestId));
    } catch (error) {
        // La solicitud ya está cancelada en PostgreSQL; Redis no debe revertir la operación.
        console.error('No se pudo detener el temporizador Redis:', error);
    }

    await eventBus.notify(
        new ServiceRequestStatusChangedEvent({
            requestId: requestId.toString(),
            fromStatus: cancellation.fromStatus,
            toStatus: 'cancelada',
            changedBy: actor.id,
            clientId: cancellation.clientId.toString(),
            employeeId: cancellation.employeeId?.toString() ?? null,
            branchId: cancellation.branchId?.toString() ?? null,
            reason: cancellation.reason,
            historyPersisted: true,
        }),
    );

    return serializeServiceRequestForResponse(requestId);
}
