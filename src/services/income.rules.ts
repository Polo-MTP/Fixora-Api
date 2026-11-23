import { desc, lte } from 'drizzle-orm';
import { commission_settings, income_records } from '../database/schema/tables.ts';
import { centsToAmount, parseAmountToCents, type DbExecutor } from './price-adjustment.rules.ts';

/**
 * Comisión de la plataforma cuando el Administrador todavía no configura una (decisión de API-38).
 * Se guarda en cada ingreso al crearlo, así que cambiarla después no toca los ingresos pasados.
 */
export const DEFAULT_COMMISSION_PERCENTAGE = '10.00';
export const MAX_COMMISSION_PERCENTAGE_HUNDREDTHS = 50_00;

export interface CommissionSplit {
  gross: string;
  commission: string;
  net: string;
}

/** Reparte un pago: lo que retiene la plataforma (redondeado al centavo) y lo que queda al proveedor. */
export function splitCommission(gross: string, percentage: string): CommissionSplit {
  const grossCents = parseAmountToCents(gross) ?? 0;
  const hundredths = parseAmountToCents(percentage) ?? 0;
  const commissionCents = Math.round((grossCents * hundredths) / 100_00);
  return {
    gross: centsToAmount(grossCents),
    commission: centsToAmount(commissionCents),
    net: centsToAmount(grossCents - commissionCents),
  };
}

/**
 * Con efectivo o transferencia el dinero le llega completo al proveedor: él debe la comisión a la
 * plataforma hasta pagarla. Solo un cobro con tarjeta (todavía no disponible) la retendría.
 */
export function commissionStatusFor(method: string): 'pendiente' | 'pagada' {
  return method === 'tarjeta' ? 'pagada' : 'pendiente';
}

/** Porcentaje vigente en [at]: el más reciente que ya entró en vigor, o el de omisión. */
export async function currentCommission(executor: DbExecutor, at = new Date()) {
  const [row] = await executor
    .select()
    .from(commission_settings)
    .where(lte(commission_settings.effective_from, at))
    .orderBy(desc(commission_settings.effective_from), desc(commission_settings.UniqueID))
    .limit(1);
  return row
    ? { percentage: row.percentage, effective_from: row.effective_from, is_default: false }
    : { percentage: DEFAULT_COMMISSION_PERCENTAGE, effective_from: null, is_default: true };
}

/**
 * Al confirmarse un pago: registra el ingreso con bruto, comisión y neto, en la misma transacción
 * que la confirmación. Si el pago ya tenía su ingreso no hace nada.
 */
export async function recordIncomeForPayment(
  executor: DbExecutor,
  request: { UniqueID: bigint; branch_id: bigint | null },
  payment: { UniqueID: bigint; amount: string; method: string; currency: string },
  at = new Date(),
) {
  // Sin sucursal no hay a quién atribuir el ingreso; una solicitud aceptada siempre la tiene.
  if (request.branch_id === null) return null;
  const { percentage } = await currentCommission(executor, at);
  const split = splitCommission(payment.amount, percentage);
  const commissionStatus = commissionStatusFor(payment.method);
  const [row] = await executor
    .insert(income_records)
    .values({
      branch_id: request.branch_id,
      request_id: request.UniqueID,
      payment_id: payment.UniqueID,
      gross_amount: split.gross,
      commission_amount: split.commission,
      net_amount: split.net,
      currency: payment.currency,
      commission_status: commissionStatus,
      ...(commissionStatus === 'pagada' ? { commission_paid_at: at } : {}),
      created_at: at,
    })
    .onConflictDoNothing({ target: income_records.payment_id })
    .returning();
  return row ?? null;
}

export function serializeIncome(row: typeof income_records.$inferSelect) {
  return {
    id: row.UniqueID.toString(),
    branch_id: row.branch_id.toString(),
    request_id: row.request_id.toString(),
    payment_id: row.payment_id.toString(),
    gross_amount: row.gross_amount,
    commission_amount: row.commission_amount,
    net_amount: row.net_amount,
    currency: row.currency,
    status: row.status,
    commission_status: row.commission_status,
    commission_paid_at: row.commission_paid_at,
    settled_at: row.settled_at,
    created_at: row.created_at,
  };
}
