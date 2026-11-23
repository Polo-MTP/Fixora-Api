import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  categories,
  employees,
  price_adjustment,
  service_payments,
  service_requests,
} from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import {
  DebtReminderEvent,
  PaymentRegisteredEvent,
  PaymentRespondedEvent,
} from '../events/events/domain-events.ts';
import {
  PAYMENT_METHODS,
  loadPayments,
  serializePayment,
  summarizePayments,
  totalToCharge,
  type PaymentMethod,
} from './payment.rules.ts';
import { centsToAmount, parseAmountToCents, type DbExecutor } from './price-adjustment.rules.ts';
import { getAccessScope, getServiceRequest } from './service-request-status.service.ts';
import { recordIncomeForPayment } from './income.rules.ts';
import { nextReminderAllowedAt, reminderHistory } from './debt-reminder.service.ts';

interface Actor {
  id: string;
  role: string;
}

const PROVIDER_ROLES = ['empleado', 'gerente', 'proveedor'];

function parseBody(rawBody: unknown, allowed: string[]): Record<string, unknown> {
  if (rawBody === undefined || rawBody === null) return {};
  if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = rawBody as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }
  return body;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new BadRequestError(
      `${field} debe ser texto de hasta ${max} caracteres.`,
      'VALIDATION_ERROR',
    );
  }
  return value.trim() || null;
}

export interface PaymentInput {
  method: PaymentMethod;
  /** null: paga todo lo que falta. */
  amountCents: number | null;
  reference: string | null;
  clientUuid: string | null;
}

export function validatePayment(rawBody: unknown): PaymentInput {
  const body = parseBody(rawBody, ['method', 'amount', 'reference', 'client_uuid']);
  if (body.method === 'tarjeta') {
    throw new BadRequestError(
      'El pago con tarjeta todavía no está disponible. Registra efectivo o transferencia.',
      'PAYMENT_METHOD_UNAVAILABLE',
    );
  }
  if (typeof body.method !== 'string' || !PAYMENT_METHODS.includes(body.method as PaymentMethod)) {
    throw new BadRequestError(
      `method debe ser uno de: ${PAYMENT_METHODS.join(', ')}.`,
      'VALIDATION_ERROR',
    );
  }

  let amountCents: number | null = null;
  if (body.amount !== undefined && body.amount !== null) {
    amountCents = parseAmountToCents(body.amount);
    if (amountCents === null || amountCents <= 0) {
      throw new BadRequestError(
        'amount debe ser mayor a 0, con máximo 2 decimales.',
        'VALIDATION_ERROR',
      );
    }
  }

  const clientUuid = optionalText(body.client_uuid, 'client_uuid', 100);
  return {
    method: body.method as PaymentMethod,
    amountCents,
    reference: optionalText(body.reference, 'reference', 255),
    clientUuid,
  };
}

async function technicianUserIds(executor: DbExecutor, employeeId: bigint | null) {
  if (!employeeId) return [];
  const [employee] = await executor
    .select({ userId: employees.user_id })
    .from(employees)
    .where(eq(employees.UniqueID, employeeId))
    .limit(1);
  return employee ? [employee.userId.toString()] : [];
}

/** Pagos de la solicitud y lo que falta; los ve quien puede ver la solicitud. */
export async function listRequestPayments(requestId: bigint, actor: Actor) {
  const request = await getServiceRequest(requestId, actor);
  return {
    summary: request.payment_summary,
    payments: request.payments,
  };
}

/** El cliente registra que pagó; queda pendiente hasta que el proveedor confirme que lo recibió. */
export async function registerPayment(requestId: bigint, actor: Actor, rawBody: unknown) {
  const input = validatePayment(rawBody);
  if (actor.role.trim().toLowerCase() !== 'cliente') {
    throw new ForbiddenError(
      'Solo el cliente de la solicitud registra el pago.',
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
    if (!request || request.client_id !== actorId) throw new NotFoundError();

    if (input.clientUuid) {
      const [existing] = await tx
        .select()
        .from(service_payments)
        .where(
          and(
            eq(service_payments.request_id, requestId),
            eq(service_payments.client_uuid, input.clientUuid),
          ),
        )
        .limit(1);
      if (existing) return { row: existing, created: false, request };
    }

    if (request.status !== 'completada') {
      throw new ConflictError(
        'El pago se registra cuando el técnico finaliza el servicio.',
        'INVALID_REQUEST_STATUS',
      );
    }
    const payments = await loadPayments(tx, requestId);
    if (payments.some((payment) => payment.status === 'pendiente')) {
      throw new ConflictError(
        'Ya hay un pago esperando que el proveedor lo confirme.',
        'PAYMENT_PENDING',
      );
    }
    const summary = summarizePayments(await totalToCharge(tx, request), payments, true);
    const balance = parseAmountToCents(summary.balance_due) ?? 0;
    if (balance === 0) {
      throw new ConflictError('Este servicio ya está pagado.', 'NOTHING_TO_PAY');
    }
    const amount = input.amountCents ?? balance;
    if (amount > balance) {
      throw new BadRequestError(
        `El monto no puede ser mayor a lo que falta por pagar ($${summary.balance_due}).`,
        'AMOUNT_EXCEEDS_BALANCE',
      );
    }

    const [row] = await tx
      .insert(service_payments)
      .values({
        request_id: requestId,
        amount: centsToAmount(amount),
        method: input.method,
        reference: input.reference,
        client_uuid: input.clientUuid,
        registered_by: actorId,
      })
      .returning();
    return { row, created: true, request };
  });

  if (result.created) {
    await eventBus.notify(
      new PaymentRegisteredEvent({
        requestId: requestId.toString(),
        paymentId: result.row.UniqueID.toString(),
        clientId: result.request.client_id.toString(),
        employeeId: result.request.employee_id?.toString() ?? null,
        providerUserIds: await technicianUserIds(db, result.request.employee_id),
        amount: result.row.amount,
        method: result.row.method,
      }),
    );
  }
  return { created: result.created, payment: serializePayment(result.row) };
}

/**
 * Del lado del proveedor (técnico asignado, dueño o gerente de la sucursal): confirma que recibió el
 * pago o dice que no le llegó. Al quedar pagado todo, los ajustes aprobados pasan a pagados.
 */
export async function respondPayment(
  requestId: bigint,
  paymentId: bigint,
  actor: Actor,
  decision: 'completado' | 'fallido',
  rawBody: unknown,
) {
  const body = parseBody(rawBody, ['reason']);
  const reason = decision === 'fallido' ? optionalText(body.reason, 'reason', 500) : null;
  if (!PROVIDER_ROLES.includes(actor.role.trim().toLowerCase())) {
    throw new ForbiddenError(
      'Solo el proveedor confirma que recibió el pago.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
  const scope = await getAccessScope(actor);
  const actorId = BigInt(actor.id);
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(service_requests)
      .where(and(eq(service_requests.UniqueID, requestId), scope.condition))
      .for('update')
      .limit(1);
    if (!request) throw new NotFoundError();

    const [payment] = await tx
      .select()
      .from(service_payments)
      .where(
        and(eq(service_payments.UniqueID, paymentId), eq(service_payments.request_id, requestId)),
      )
      .limit(1);
    if (!payment) throw new NotFoundError('El pago no existe.');
    if (payment.status !== 'pendiente') {
      throw new ConflictError('Este pago ya fue respondido.', 'PAYMENT_ALREADY_RESPONDED');
    }

    const [updated] = await tx
      .update(service_payments)
      .set({
        status: decision,
        confirmed_by: actorId,
        responded_at: now,
        rejection_reason: reason,
        ...(decision === 'completado' ? { paid_at: now } : {}),
      })
      .where(eq(service_payments.UniqueID, paymentId))
      .returning();

    const summary = summarizePayments(
      await totalToCharge(tx, request),
      await loadPayments(tx, requestId),
      request.status === 'completada',
    );
    // Cada pago confirmado es un ingreso del proveedor con la comisión de la plataforma (API-38).
    if (decision === 'completado') await recordIncomeForPayment(tx, request, updated, now);
    if (decision === 'completado' && summary.balance_due === '0.00') {
      await tx
        .update(price_adjustment)
        .set({ status: 'pagado', paid_at: now })
        .where(
          and(eq(price_adjustment.request_id, requestId), eq(price_adjustment.status, 'aprobado')),
        );
    }
    return { updated, request, summary };
  });

  await eventBus.notify(
    new PaymentRespondedEvent({
      requestId: requestId.toString(),
      paymentId: paymentId.toString(),
      clientId: result.request.client_id.toString(),
      employeeId: result.request.employee_id?.toString() ?? null,
      branchId: result.request.branch_id?.toString() ?? null,
      amount: result.updated.amount,
      method: result.updated.method,
      decision,
      reason,
      balanceDue: result.summary.balance_due,
    }),
  );
  return { payment: serializePayment(result.updated), summary: result.summary };
}

function parsePagination(query: { page?: unknown; limit?: unknown }) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new BadRequestError('page debe ser 1 o más y limit entre 1 y 50.', 'VALIDATION_ERROR');
  }
  return { page, limit };
}

/** Historial de pagos de la cuenta: los que hizo el cliente o los que recibió el proveedor. */
export async function listMyPayments(actor: Actor, query: { page?: unknown; limit?: unknown }) {
  const { page, limit } = parsePagination(query);
  const scope = await getAccessScope(actor);
  const where = scope.condition;
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(service_payments)
    .innerJoin(service_requests, eq(service_payments.request_id, service_requests.UniqueID))
    .where(where);
  const rows = await db
    .select({ payment: service_payments, category: categories.name })
    .from(service_payments)
    .innerJoin(service_requests, eq(service_payments.request_id, service_requests.UniqueID))
    .leftJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .where(where)
    .orderBy(desc(service_payments.created_at), desc(service_payments.UniqueID))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(count?.total ?? 0);
  return {
    data: rows.map((row) => ({
      ...serializePayment(row.payment),
      request_id: row.payment.request_id.toString(),
      category: row.category,
    })),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

/**
 * Adeudos: servicios terminados con saldo. Para el cliente, lo que debe; para el proveedor, lo que
 * le deben. Se calcula al vuelo con los pagos confirmados, no se guarda aparte.
 */
export async function listMyDebts(actor: Actor) {
  const scope = await getAccessScope(actor);
  const requests = await db
    .select({ request: service_requests, category: categories.name })
    .from(service_requests)
    .leftJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .where(and(scope.condition, eq(service_requests.status, 'completada')))
    .orderBy(desc(service_requests.completed_at));
  if (!requests.length) return { total_due: '0.00', debts: [] };

  const ids = requests.map((row) => row.request.UniqueID);
  const payments = await db
    .select()
    .from(service_payments)
    .where(inArray(service_payments.request_id, ids));
  const reminders = await reminderHistory(ids);
  const now = new Date();
  const debts = [];
  let totalDue = 0;
  for (const { request, category } of requests) {
    const summary = summarizePayments(
      await totalToCharge(db, request),
      payments.filter((payment) => payment.request_id === request.UniqueID),
      true,
    );
    if (!summary.has_debt) continue;
    totalDue += parseAmountToCents(summary.balance_due) ?? 0;
    const history = reminders.get(request.UniqueID.toString());
    debts.push({
      request_id: request.UniqueID.toString(),
      category,
      completed_at: request.completed_at,
      ...summary,
      // Recordatorios (automáticos y manuales): el último y desde cuándo se puede mandar otro.
      reminders_sent: history?.count ?? 0,
      last_reminder_at: history?.last ?? null,
      next_reminder_at: nextReminderAllowedAt(history?.last, now),
    });
  }
  return { total_due: centsToAmount(totalDue), debts };
}

/**
 * El proveedor le recuerda al cliente un adeudo desde la app (API-53). Máximo uno cada 24 horas
 * por servicio, contando también los automáticos, para que no se pueda usar para molestarlo; y no
 * se manda si el cliente ya registró un pago que espera confirmación.
 */
export async function sendManualDebtReminder(requestId: bigint, actor: Actor) {
  if (!PROVIDER_ROLES.includes(actor.role.trim().toLowerCase())) {
    throw new ForbiddenError(
      'Solo el proveedor puede recordarle un adeudo al cliente.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
  const scope = await getAccessScope(actor);
  const [request] = await db
    .select()
    .from(service_requests)
    .where(and(eq(service_requests.UniqueID, requestId), scope.condition))
    .limit(1);
  if (!request) throw new NotFoundError();

  const summary = summarizePayments(
    await totalToCharge(db, request),
    await loadPayments(db, requestId),
    request.status === 'completada',
  );
  if (!summary.has_debt) {
    throw new ConflictError('Este servicio no tiene adeudo.', 'NO_DEBT');
  }
  if (summary.pending_confirmation !== '0.00') {
    throw new ConflictError(
      'El cliente ya registró un pago que espera tu confirmación.',
      'PAYMENT_PENDING_CONFIRMATION',
    );
  }

  const history = (await reminderHistory([requestId])).get(requestId.toString());
  const next = nextReminderAllowedAt(history?.last);
  if (next) {
    throw new ConflictError(
      `Ya se le recordó en las últimas 24 horas. Puedes volver a hacerlo a partir de ${next.toISOString()}.`,
      'REMINDER_TOO_SOON',
    );
  }

  await eventBus.notify(
    new DebtReminderEvent({
      requestId: requestId.toString(),
      clientId: request.client_id.toString(),
      balanceDue: summary.balance_due,
    }),
  );
  const sentAt = new Date();
  return {
    request_id: requestId.toString(),
    balance_due: summary.balance_due,
    sent_at: sentAt,
    next_reminder_at: nextReminderAllowedAt(sentAt, sentAt),
  };
}
