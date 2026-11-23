import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { employees, price_adjustment, service_requests } from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import {
  PriceAdjustmentProposedEvent,
  PriceAdjustmentRespondedEvent,
} from '../events/events/domain-events.ts';
import {
  MAX_ADJUSTMENT_AMOUNT_CENTS,
  centsToAmount,
  computeTotalAmount,
  countsTowardTotal,
  loadPriceAdjustments,
  parseAmountToCents,
  parseReason,
  serializePriceAdjustment,
} from './price-adjustment.rules.ts';
import { getServiceRequest, isAssignedTechnician } from './service-request-status.service.ts';

interface Actor {
  id: string;
  role: string;
}

/** El técnico propone ajustes ya en el domicilio, cuando ve el trabajo real. */
const PROPOSABLE_STATUSES = ['llegado'];

function parseBody(rawBody: unknown, allowed: string[]): Record<string, unknown> {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = rawBody as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }
  return body;
}

export interface ProposalInput {
  amountCents: number;
  reason: ReturnType<typeof parseReason>;
  description: string | null;
  clientUuid: string | null;
}

export function validateProposal(rawBody: unknown): ProposalInput {
  const body = parseBody(rawBody, ['amount', 'reason', 'description', 'client_uuid']);
  const amountCents = parseAmountToCents(body.amount);
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_ADJUSTMENT_AMOUNT_CENTS) {
    throw new BadRequestError(
      `amount debe ser mayor a 0 y hasta ${centsToAmount(MAX_ADJUSTMENT_AMOUNT_CENTS)}, con máximo 2 decimales.`,
      'VALIDATION_ERROR',
    );
  }
  const reason = parseReason(body.reason);

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || body.description.trim().length > 500) {
      throw new BadRequestError(
        'description debe ser texto de hasta 500 caracteres.',
        'VALIDATION_ERROR',
      );
    }
    description = body.description.trim() || null;
  }
  // «Otro» no dice nada por sí solo: el cliente necesita saber qué se cobra.
  if (reason === 'otro' && !description) {
    throw new BadRequestError(
      'Explica el ajuste en description cuando el motivo es "otro".',
      'VALIDATION_ERROR',
    );
  }

  let clientUuid: string | null = null;
  if (body.client_uuid !== undefined && body.client_uuid !== null) {
    if (
      typeof body.client_uuid !== 'string' ||
      !body.client_uuid.trim() ||
      body.client_uuid.length > 100
    ) {
      throw new BadRequestError(
        'client_uuid debe ser texto de hasta 100 caracteres.',
        'VALIDATION_ERROR',
      );
    }
    clientUuid = body.client_uuid.trim();
  }

  return { amountCents, reason, description, clientUuid };
}

/** Ajustes de la solicitud con el total que llevan; los ve quien puede ver la solicitud. */
export async function listPriceAdjustments(requestId: bigint, actor: Actor) {
  // getServiceRequest revisa el acceso y ya trae los ajustes serializados.
  const request = await getServiceRequest(requestId, actor);
  const approved = request.price_adjustments
    .filter((item) => countsTowardTotal(item.status))
    .map((item) => item.amount);
  return {
    agreed_price: request.agreed_price,
    approved_total: computeTotalAmount(null, approved),
    total_amount: request.total_amount ?? computeTotalAmount(request.agreed_price, approved),
    adjustments: request.price_adjustments,
  };
}

/** El técnico asignado propone cobrar más; queda pendiente hasta que el cliente responde. */
export async function proposePriceAdjustment(requestId: bigint, actor: Actor, rawBody: unknown) {
  const input = validateProposal(rawBody);
  const role = actor.role.trim().toLowerCase();
  if (role !== 'empleado' && role !== 'proveedor') {
    throw new ForbiddenError(
      'Solo el técnico asignado puede proponer ajustes de precio.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
  const actorId = BigInt(actor.id);

  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(service_requests)
      .where(eq(service_requests.UniqueID, requestId))
      .for('update')
      .limit(1);
    if (!request) throw new NotFoundError();
    if (!(await isAssignedTechnician(tx, request, actorId, role))) throw new NotFoundError();

    // Reintento con la misma llave: se regresa el mismo ajuste en vez de duplicarlo.
    if (input.clientUuid) {
      const [existing] = await tx
        .select()
        .from(price_adjustment)
        .where(
          and(
            eq(price_adjustment.request_id, requestId),
            eq(price_adjustment.client_uuid, input.clientUuid),
          ),
        )
        .limit(1);
      if (existing) return { row: existing, created: false, request };
    }

    if (!PROPOSABLE_STATUSES.includes(request.status)) {
      throw new ConflictError(
        'Solo puedes proponer un ajuste cuando ya llegaste al domicilio.',
        'INVALID_REQUEST_STATUS',
      );
    }
    const [pending] = await tx
      .select({ id: price_adjustment.UniqueID })
      .from(price_adjustment)
      .where(
        and(eq(price_adjustment.request_id, requestId), eq(price_adjustment.status, 'pendiente')),
      )
      .limit(1);
    if (pending) {
      throw new ConflictError(
        'Ya hay un ajuste esperando la respuesta del cliente.',
        'PRICE_ADJUSTMENT_PENDING',
      );
    }

    const [row] = await tx
      .insert(price_adjustment)
      .values({
        request_id: requestId,
        amount: centsToAmount(input.amountCents),
        reason: input.reason,
        description: input.description,
        declared_by: actorId,
        client_uuid: input.clientUuid,
      })
      .returning();
    return { row, created: true, request };
  });

  if (result.created) {
    await eventBus.notify(
      new PriceAdjustmentProposedEvent({
        requestId: requestId.toString(),
        adjustmentId: result.row.UniqueID.toString(),
        clientId: result.request.client_id.toString(),
        employeeId: result.request.employee_id?.toString() ?? null,
        amount: result.row.amount,
        reason: result.row.reason,
        description: result.row.description,
      }),
    );
  }
  return { created: result.created, adjustment: serializePriceAdjustment(result.row) };
}

/** El cliente aprueba o rechaza un ajuste pendiente de su solicitud. */
export async function respondPriceAdjustment(
  requestId: bigint,
  adjustmentId: bigint,
  actor: Actor,
  decision: 'aprobado' | 'rechazado',
) {
  const actorId = BigInt(actor.id);
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(service_requests)
      .where(eq(service_requests.UniqueID, requestId))
      .for('update')
      .limit(1);
    // Para quien no es el cliente, la solicitud no existe.
    if (!request || request.client_id !== actorId) throw new NotFoundError();

    const [adjustment] = await tx
      .select()
      .from(price_adjustment)
      .where(
        and(
          eq(price_adjustment.UniqueID, adjustmentId),
          eq(price_adjustment.request_id, requestId),
        ),
      )
      .limit(1);
    if (!adjustment) throw new NotFoundError('El ajuste de precio no existe.');
    if (adjustment.status !== 'pendiente') {
      throw new ConflictError(
        `Este ajuste ya fue ${adjustment.status}.`,
        'PRICE_ADJUSTMENT_ALREADY_RESPONDED',
      );
    }
    if (!PROPOSABLE_STATUSES.includes(request.status)) {
      throw new ConflictError(
        'La solicitud ya no admite cambios de precio.',
        'INVALID_REQUEST_STATUS',
      );
    }

    const [updated] = await tx
      .update(price_adjustment)
      .set({ status: decision, responded_at: now })
      .where(eq(price_adjustment.UniqueID, adjustmentId))
      .returning();

    const technicianUserIds: string[] = [];
    if (request.employee_id) {
      const [employee] = await tx
        .select({ userId: employees.user_id })
        .from(employees)
        .where(eq(employees.UniqueID, request.employee_id))
        .limit(1);
      if (employee) technicianUserIds.push(employee.userId.toString());
    }
    return { updated, request, technicianUserIds };
  });

  await eventBus.notify(
    new PriceAdjustmentRespondedEvent({
      requestId: requestId.toString(),
      adjustmentId: adjustmentId.toString(),
      clientId: result.request.client_id.toString(),
      employeeId: result.request.employee_id?.toString() ?? null,
      technicianUserIds: result.technicianUserIds,
      amount: result.updated.amount,
      decision,
    }),
  );

  const all = await loadPriceAdjustments(db, requestId);
  return {
    adjustment: serializePriceAdjustment(result.updated),
    total_amount: computeTotalAmount(
      result.request.agreed_price,
      all.filter((row) => countsTowardTotal(row.status)).map((row) => row.amount),
    ),
  };
}
