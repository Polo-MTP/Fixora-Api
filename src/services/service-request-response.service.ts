import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import {
  branches,
  branches_categories,
  business_supplier,
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
  ServiceRequestRejectedEvent,
  ServiceRequestStatusChangedEvent,
} from '../events/events/domain-events.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { timerService } from './timer.service.ts';
import { serializeServiceRequestForResponse } from './service-request-status.service.ts';

interface Actor {
  id: string;
  role: string;
}

function parseEmployeeId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError('employee_id debe ser un identificador válido.', 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
    throw new BadRequestError(
      'reason es obligatorio y no debe exceder 500 caracteres.',
      'VALIDATION_ERROR',
    );
  }
  return value.trim();
}

async function getOwnedBranchIds(actorId: bigint): Promise<bigint[]> {
  const rows = await db
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

  return [...new Set(rows.map((row) => row.id.toString()))].map((id) => BigInt(id));
}

async function assertCanManageEmployee(
  actor: Actor,
  employeeId: bigint,
  branchId: bigint,
): Promise<void> {
  const actorId = BigInt(actor.id);
  const [employee] = await db
    .select({
      branchId: employees.branch_id,
      userId: employees.user_id,
      active: employees.active,
      canAttend: employees.can_attend,
    })
    .from(employees)
    .innerJoin(users, eq(employees.user_id, users.UniqueID))
    .innerJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(
      and(
        eq(employees.UniqueID, employeeId),
        eq(users.state, 'activo'),
        inArray(roles.name, ['empleado', 'proveedor']),
        eq(roles.active, true),
      ),
    )
    .limit(1);

  if (!employee || !employee.active || !employee.canAttend || employee.branchId !== branchId) {
    throw new NotFoundError('El técnico no pertenece a la sucursal o no está disponible.');
  }

  const role = actor.role.trim().toLowerCase();
  if (role === 'empleado') {
    if (employee.userId !== actorId) {
      throw new ForbiddenError(
        'Solo puedes responder como el técnico de tu propia cuenta.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }
    return;
  }

  if (role !== 'proveedor') {
    throw new ForbiddenError(
      'Solo un proveedor o técnico puede responder solicitudes.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }

  const branchIds = await getOwnedBranchIds(actorId);
  if (!branchIds.some((id) => id === branchId)) throw new NotFoundError();
}

export async function acceptServiceRequest(requestId: bigint, actor: Actor, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }

  const body = rawBody as Record<string, unknown>;
  const allowed = ['employee_id', 'latitude', 'longitude'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }

  if (body.latitude !== undefined) {
    const lat = Number(body.latitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new BadRequestError(
        'La latitud debe ser un número entre -90 y 90.',
        'VALIDATION_ERROR',
      );
    }
  }
  if (body.longitude !== undefined) {
    const lng = Number(body.longitude);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new BadRequestError(
        'La longitud debe ser un número entre -180 y 180.',
        'VALIDATION_ERROR',
      );
    }
  }

  const employeeId = parseEmployeeId(body.employee_id);
  const actorId = BigInt(actor.id);
  const now = new Date();
  let clientId: bigint | null = null;
  let branchId: bigint | null = null;

  await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(service_requests)
      .where(eq(service_requests.UniqueID, requestId))
      .for('update')
      .limit(1);

    if (!request) throw new NotFoundError();
    if (request.status !== 'pendiente' || (request.expires_at && request.expires_at <= now)) {
      throw new ConflictError(
        'La solicitud ya no está pendiente, expiró o fue aceptada por otro técnico.',
        'REQUEST_NOT_PENDING',
      );
    }

    const [employee] = await tx
      .select({
        id: employees.UniqueID,
        branchId: employees.branch_id,
        active: employees.active,
        canAttend: employees.can_attend,
      })
      .from(employees)
      .where(eq(employees.UniqueID, employeeId))
      .limit(1);

    if (!employee || !employee.active || !employee.canAttend) {
      throw new NotFoundError('El técnico no existe o no está disponible.');
    }
    branchId = employee.branchId;

    if (request.is_emergency) {
      const [dispatch] = await tx
        .select({ id: request_dispatches.UniqueID })
        .from(request_dispatches)
        .where(
          and(
            eq(request_dispatches.request_id, requestId),
            eq(request_dispatches.employee_id, employeeId),
            isNull(request_dispatches.response),
          ),
        )
        .limit(1);

      if (!dispatch) {
        throw new NotFoundError('La solicitud no fue enviada a este técnico o ya respondió.');
      }
    } else {
      if (request.branch_id !== employee.branchId) {
        throw new NotFoundError('El técnico no pertenece a la sucursal de la solicitud.');
      }
      if (request.employee_id && request.employee_id !== employeeId) {
        throw new ConflictError(
          'La solicitud ya está asignada a otro técnico.',
          'REQUEST_NOT_PENDING',
        );
      }
    }

    await assertCanManageEmployee(actor, employeeId, employee.branchId);

    const [price] = await tx
      .select({ amount: branches_categories.base_price })
      .from(branches_categories)
      .where(
        and(
          eq(branches_categories.branch_id, employee.branchId),
          eq(branches_categories.category_id, request.category_id),
          eq(branches_categories.active, true),
        ),
      )
      .limit(1);

    if (!price) {
      throw new ConflictError(
        'La sucursal no tiene un precio activo para esta categoría.',
        'CATEGORY_PRICE_NOT_CONFIGURED',
      );
    }

    const [updated] = await tx
      .update(service_requests)
      .set({
        employee_id: employeeId,
        branch_id: employee.branchId,
        agreed_price: price.amount,
        accepted_at: now,
        expires_at: null,
        status: 'aceptada',
      })
      .where(
        and(eq(service_requests.UniqueID, requestId), eq(service_requests.status, 'pendiente')),
      )
      .returning({ id: service_requests.UniqueID });

    if (!updated) {
      throw new ConflictError('Otro técnico ya aceptó la solicitud.', 'REQUEST_NOT_PENDING');
    }

    if (request.is_emergency) {
      await tx
        .update(request_dispatches)
        .set({ response: 'retirado', responded_at: now })
        .where(
          and(eq(request_dispatches.request_id, requestId), isNull(request_dispatches.response)),
        );
      await tx
        .update(request_dispatches)
        .set({ response: 'acepto', responded_at: now })
        .where(
          and(
            eq(request_dispatches.request_id, requestId),
            eq(request_dispatches.employee_id, employeeId),
          ),
        );
    } else {
      const [existingDispatch] = await tx
        .select({ id: request_dispatches.UniqueID })
        .from(request_dispatches)
        .where(
          and(
            eq(request_dispatches.request_id, requestId),
            eq(request_dispatches.employee_id, employeeId),
          ),
        )
        .limit(1);

      if (existingDispatch) {
        await tx
          .update(request_dispatches)
          .set({ response: 'acepto', responded_at: now })
          .where(eq(request_dispatches.UniqueID, existingDispatch.id));
      } else {
        await tx.insert(request_dispatches).values({
          request_id: requestId,
          employee_id: employeeId,
          notified_at: now,
          responded_at: now,
          response: 'acepto',
        });
      }
    }

    let acceptLat: string | null = null;
    let acceptLng: string | null = null;
    if (typeof body.latitude === 'number' && typeof body.longitude === 'number') {
      acceptLat = String(body.latitude);
      acceptLng = String(body.longitude);
    } else {
      try {
        const onlineData = await redis.get(redisKeys.technicianOnline(employeeId));
        if (onlineData) {
          const parsed = JSON.parse(onlineData) as { latitude?: number; longitude?: number };
          if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
            acceptLat = String(parsed.latitude);
            acceptLng = String(parsed.longitude);
          }
        }
      } catch {
        // Redis opcional
      }
    }

    await tx.insert(service_request_events).values({
      request_id: requestId,
      from_status: request.status,
      to_status: 'aceptada',
      changed_by: actorId,
      latitude: acceptLat,
      longitude: acceptLng,
      created_at: now,
    });
    clientId = request.client_id;
  });

  try {
    await timerService.cancel(redisKeys.requestTimer(requestId));
  } catch (error) {
    console.error('[API-30] No se pudo detener el temporizador Redis:', error);
  }

  await eventBus.notify(
    new ServiceRequestStatusChangedEvent({
      requestId: requestId.toString(),
      fromStatus: 'pendiente',
      toStatus: 'aceptada',
      changedBy: actor.id,
      clientId: clientId!.toString(),
      employeeId: employeeId.toString(),
      branchId: branchId!.toString(),
      historyPersisted: true,
    }),
  );

  return serializeServiceRequestForResponse(requestId);
}

export async function rejectServiceRequest(requestId: bigint, actor: Actor, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }

  const body = rawBody as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => key !== 'reason');
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }

  const reason = parseReason(body.reason);
  const actorId = BigInt(actor.id);
  const now = new Date();
  let clientId: bigint | null = null;
  let employeeIds: bigint[] = [];
  let isEmergency = false;

  await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(service_requests)
      .where(eq(service_requests.UniqueID, requestId))
      .for('update')
      .limit(1);

    if (!request) throw new NotFoundError();
    if (request.status !== 'pendiente' || (request.expires_at && request.expires_at <= now)) {
      throw new ConflictError('La solicitud ya no está pendiente.', 'REQUEST_NOT_PENDING');
    }

    isEmergency = request.is_emergency;
    clientId = request.client_id;

    let allowedEmployeeIds: bigint[];
    const role = actor.role.trim().toLowerCase();

    if (role === 'empleado') {
      const rows = await tx
        .select({ id: employees.UniqueID, branchId: employees.branch_id })
        .from(employees)
        .where(and(eq(employees.user_id, actorId), eq(employees.active, true)));
      allowedEmployeeIds = rows
        .filter((row) => request.is_emergency || row.branchId === request.branch_id)
        .map((row) => row.id);
    } else if (role === 'proveedor') {
      const rows = await tx
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
      const branchIds = rows.map((row) => row.id);

      if (!request.is_emergency && (!request.branch_id || !branchIds.includes(request.branch_id))) {
        throw new NotFoundError();
      }
      if (request.is_emergency && branchIds.length === 0) throw new NotFoundError();

      const employeeRows = await tx
        .select({ id: employees.UniqueID })
        .from(employees)
        .where(
          and(
            inArray(employees.branch_id, request.is_emergency ? branchIds : [request.branch_id!]),
            eq(employees.active, true),
          ),
        );
      allowedEmployeeIds = employeeRows.map((row) => row.id);
    } else {
      throw new ForbiddenError(
        'Solo un proveedor o técnico puede rechazar solicitudes.',
        'INSUFFICIENT_PERMISSIONS',
      );
    }

    if (!request.is_emergency && request.employee_id) {
      allowedEmployeeIds = allowedEmployeeIds.filter((id) => id === request.employee_id);
    }

    if (!allowedEmployeeIds.length) {
      throw new NotFoundError('No hay un técnico de tu cuenta asociado a esta solicitud.');
    }

    const dispatchRows = await tx
      .select({ id: request_dispatches.UniqueID, employeeId: request_dispatches.employee_id })
      .from(request_dispatches)
      .where(
        and(
          eq(request_dispatches.request_id, requestId),
          inArray(request_dispatches.employee_id, allowedEmployeeIds),
          isNull(request_dispatches.response),
        ),
      );

    if (dispatchRows.length) {
      await tx
        .update(request_dispatches)
        .set({ response: 'rechazo', responded_at: now })
        .where(
          inArray(
            request_dispatches.UniqueID,
            dispatchRows.map((row) => row.id),
          ),
        );
      employeeIds = dispatchRows.map((row) => row.employeeId);
    } else if (!request.is_emergency) {
      const employeeId =
        request.employee_id && allowedEmployeeIds.includes(request.employee_id)
          ? request.employee_id
          : allowedEmployeeIds[0]!;
      await tx.insert(request_dispatches).values({
        request_id: requestId,
        employee_id: employeeId,
        notified_at: now,
        responded_at: now,
        response: 'rechazo',
      });
      employeeIds = [employeeId];
    } else {
      throw new ConflictError(
        'Este técnico ya respondió o no recibió la solicitud.',
        'REQUEST_NOT_PENDING',
      );
    }
  });

  await eventBus.notify(
    new ServiceRequestRejectedEvent({
      requestId: requestId.toString(),
      clientId: clientId!.toString(),
      employeeIds: employeeIds.map((id) => id.toString()),
      reason,
      isEmergency,
    }),
  );

  return { success: true, message: 'Solicitud rechazada.' };
}
