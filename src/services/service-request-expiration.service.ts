import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
    request_dispatches,
    service_request_events,
    service_requests,
} from '../database/schema/tables.ts';
import { eventBus } from '../events/event-bus.ts';
import { ServiceRequestStatusChangedEvent } from '../events/events/domain-events.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { timerService } from './timer.service.ts';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 100;

/**
 * Expira solicitudes pendientes usando expires_at persistido en PostgreSQL como fuente de verdad.
 * Redis conserva el temporizador operativo, pero el proceso se recupera después de reinicios
 * consultando PostgreSQL; por eso no depende de keyspace notifications ni de memoria del proceso.
 */
export class ServiceRequestExpirationService {
    private interval: ReturnType<typeof setInterval> | null = null;
    private running = false;

    async start(): Promise<void> {
        if (this.interval) return;

        await this.restoreRedisTimers();
        await this.expireOverdueRequests();

        this.interval = setInterval(() => {
            void this.tick().catch((error) => {
                console.error('Error al procesar expiraciones:', error);
            });
        }, POLL_INTERVAL_MS);
        (this.interval as unknown as { unref?: () => void }).unref?.();
        console.log('Worker de expiración iniciado.');
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
    }

    private async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            await this.expireOverdueRequests();
            await this.restoreRedisTimers();
        } finally {
            this.running = false;
        }
    }

    private async restoreRedisTimers(): Promise<void> {
        const now = new Date();
        const pending = await db
            .select({ id: service_requests.UniqueID, expiresAt: service_requests.expires_at })
            .from(service_requests)
            .where(
                and(
                    eq(service_requests.status, 'pendiente'),
                    isNotNull(service_requests.expires_at),
                    gt(service_requests.expires_at, now),
                ),
            )
            .orderBy(asc(service_requests.expires_at));

        for (const request of pending) {
            if (!request.expiresAt) continue;
            const seconds = Math.ceil((request.expiresAt.getTime() - Date.now()) / 1_000);
            if (seconds <= 0) continue;
            try {
                const remaining = await timerService.remainingSeconds(redisKeys.requestTimer(request.id));
                if (remaining === 0) {
                    await timerService.start(redisKeys.requestTimer(request.id), seconds);
                }
            } catch (error) {
                // PostgreSQL mantiene el vencimiento; el worker seguirá comprobándolo aunque Redis caiga.
                console.error('No se pudo restaurar temporizador Redis:', error);
                return;
            }
        }
    }

    private async expireOverdueRequests(): Promise<void> {
        const now = new Date();
        const overdue = await db
            .select({ id: service_requests.UniqueID })
            .from(service_requests)
            .where(
                and(
                    eq(service_requests.status, 'pendiente'),
                    isNotNull(service_requests.expires_at),
                    lte(service_requests.expires_at, now),
                ),
            )
            .orderBy(asc(service_requests.expires_at))
            .limit(BATCH_SIZE);

        for (const item of overdue) await this.expireOne(item.id);
    }

    private async expireOne(requestId: bigint): Promise<void> {
        const now = new Date();
        const eventPayload = await db.transaction(async (tx) => {
            const [request] = await tx
                .select({
                    id: service_requests.UniqueID,
                    clientId: service_requests.client_id,
                    branchId: service_requests.branch_id,
                    employeeId: service_requests.employee_id,
                    status: service_requests.status,
                    expiresAt: service_requests.expires_at,
                })
                .from(service_requests)
                .where(eq(service_requests.UniqueID, requestId))
                .for('update')
                .limit(1);

            if (
                !request ||
                request.status !== 'pendiente' ||
                !request.expiresAt ||
                request.expiresAt > now
            ) {
                return null;
            }

            const [updated] = await tx
                .update(service_requests)
                .set({ status: 'expirada' })
                .where(
                    and(
                        eq(service_requests.UniqueID, requestId),
                        eq(service_requests.status, 'pendiente'),
                        lte(service_requests.expires_at, now),
                    ),
                )
                .returning({ id: service_requests.UniqueID });

            if (!updated) return null;

            await tx
                .update(request_dispatches)
                .set({ response: 'expiro', responded_at: now })
                .where(
                    and(
                        eq(request_dispatches.request_id, requestId),
                        isNull(request_dispatches.response),
                    ),
                );

            await tx.insert(service_request_events).values({
                request_id: requestId,
                from_status: 'pendiente',
                to_status: 'expirada',
                changed_by: request.clientId,
                created_at: now,
            });

            return {
                clientId: request.clientId,
                branchId: request.branchId,
                employeeId: request.employeeId,
            };
        });

        try {
            await timerService.cancel(redisKeys.requestTimer(requestId));
        } catch (error) {
            console.error('No se pudo limpiar el temporizador Redis:', error);
        }

        if (eventPayload) {
            await eventBus.notify(
                new ServiceRequestStatusChangedEvent({
                    requestId: requestId.toString(),
                    fromStatus: 'pendiente',
                    toStatus: 'expirada',
                    changedBy: eventPayload.clientId.toString(),
                    clientId: eventPayload.clientId.toString(),
                    employeeId: eventPayload.employeeId?.toString() ?? null,
                    branchId: eventPayload.branchId?.toString() ?? null,
                    historyPersisted: true,
                }),
            );
        }
    }
}

export const serviceRequestExpirationService = new ServiceRequestExpirationService();
