import { asc, eq } from 'drizzle-orm';
import { service_payments } from '../database/schema/tables.ts';
import {
  centsToAmount,
  computeTotalAmount,
  countsTowardTotal,
  loadPriceAdjustments,
  parseAmountToCents,
  type DbExecutor,
} from './price-adjustment.rules.ts';

/** Sin pasarela de pago, solo se registra lo que se cobra en persona. */
export const PAYMENT_METHODS = ['efectivo', 'transferencia'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Recordatorio de adeudo al cliente: uno al día, hasta este número. */
export const MAX_DEBT_REMINDERS = 5;
export const DEBT_REMINDER_EVERY_MS = 24 * 60 * 60 * 1000;

export interface PaymentSummary {
  total_amount: string;
  /** Confirmado por el proveedor. */
  paid: string;
  /** Registrado por el cliente, esperando que el proveedor lo confirme. */
  pending_confirmation: string;
  /** Lo que falta por pagar (total menos lo confirmado). */
  balance_due: string;
  /** Finalizada y con saldo: es un adeudo. */
  has_debt: boolean;
}

export function summarizePayments(
  totalAmount: string,
  payments: readonly { amount: string; status: string }[],
  completed: boolean,
): PaymentSummary {
  const cents = (status: string) =>
    payments
      .filter((payment) => payment.status === status)
      .reduce((sum, payment) => sum + (parseAmountToCents(payment.amount) ?? 0), 0);
  const total = parseAmountToCents(totalAmount) ?? 0;
  const paid = cents('completado');
  const balance = Math.max(total - paid, 0);
  return {
    total_amount: centsToAmount(total),
    paid: centsToAmount(paid),
    pending_confirmation: centsToAmount(cents('pendiente')),
    balance_due: centsToAmount(balance),
    has_debt: completed && balance > 0,
  };
}

export async function loadPayments(executor: DbExecutor, requestId: bigint) {
  return executor
    .select()
    .from(service_payments)
    .where(eq(service_payments.request_id, requestId))
    .orderBy(asc(service_payments.created_at), asc(service_payments.UniqueID));
}

/**
 * Total a cobrar: el que se fijó al finalizar o, si la solicitud es anterior a API-36 o no ha
 * terminado, el precio acordado más los ajustes aprobados.
 */
export async function totalToCharge(
  executor: DbExecutor,
  request: { UniqueID: bigint; total_amount: string | null; agreed_price: string | null },
): Promise<string> {
  if (request.total_amount !== null) return request.total_amount;
  const adjustments = await loadPriceAdjustments(executor, request.UniqueID);
  return computeTotalAmount(
    request.agreed_price,
    adjustments.filter((row) => countsTowardTotal(row.status)).map((row) => row.amount),
  );
}

export function serializePayment(row: typeof service_payments.$inferSelect) {
  return {
    id: row.UniqueID.toString(),
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    status: row.status,
    registered_by: row.registered_by?.toString() ?? null,
    confirmed_by: row.confirmed_by?.toString() ?? null,
    rejection_reason: row.rejection_reason,
    created_at: row.created_at,
    responded_at: row.responded_at,
    paid_at: row.paid_at,
  };
}
