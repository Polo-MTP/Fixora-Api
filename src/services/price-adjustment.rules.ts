import { asc, eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { price_adjustment } from '../database/schema/tables.ts';
import { BadRequestError, ConflictError } from '../errors/app-error.ts';

/** La conexión o la transacción en curso: las reglas sirven dentro y fuera de una transacción. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PRICE_ADJUSTMENT_REASONS = ['materiales_extra', 'tiempo_adicional', 'otro'] as const;
export type PriceAdjustmentReason = (typeof PRICE_ADJUSTMENT_REASONS)[number];

/** Tope por ajuste: evita errores de captura (un cero de más) sin limitar trabajos reales. */
export const MAX_ADJUSTMENT_AMOUNT_CENTS = 50_000_00;

/** Convierte «350», «350.5» o 350.5 a centavos; null si no es un monto válido con 2 decimales. */
export function parseAmountToCents(value: unknown): number | null {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function centsToAmount(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Total del servicio: el precio acordado más los ajustes aprobados.
 *
 * Precio de emergencia (decisión de API-36): no lleva recargo. Se cobra el precio base de la
 * sucursal que la acepta, igual que una solicitud normal (agreed_price se fija al aceptar), y lo
 * extra solo entra como un ajuste que el cliente aprueba. Así la urgencia no se usa para cobrar de
 * más, que es justo lo que el proyecto busca evitar.
 */
export function computeTotalAmount(
  agreedPrice: string | null,
  approvedAmounts: readonly string[],
): string {
  const base = agreedPrice === null ? 0 : (parseAmountToCents(agreedPrice) ?? 0);
  const extra = approvedAmounts.reduce((sum, amount) => sum + (parseAmountToCents(amount) ?? 0), 0);
  return centsToAmount(base + extra);
}

export function parseReason(value: unknown): PriceAdjustmentReason {
  if (
    typeof value !== 'string' ||
    !PRICE_ADJUSTMENT_REASONS.includes(value as PriceAdjustmentReason)
  ) {
    throw new BadRequestError(
      `reason debe ser uno de: ${PRICE_ADJUSTMENT_REASONS.join(', ')}.`,
      'VALIDATION_ERROR',
    );
  }
  return value as PriceAdjustmentReason;
}

/** Aprobado por el cliente, o ya pagado junto con el servicio (API-37): suma al total. */
export function countsTowardTotal(status: string): boolean {
  return status === 'aprobado' || status === 'pagado';
}

export async function loadPriceAdjustments(executor: DbExecutor, requestId: bigint) {
  return executor
    .select()
    .from(price_adjustment)
    .where(eq(price_adjustment.request_id, requestId))
    .orderBy(asc(price_adjustment.created_at), asc(price_adjustment.UniqueID));
}

export function serializePriceAdjustment(row: typeof price_adjustment.$inferSelect) {
  return {
    id: row.UniqueID.toString(),
    amount: row.amount,
    reason: row.reason,
    description: row.description,
    status: row.status,
    declared_by: row.declared_by.toString(),
    created_at: row.created_at,
    responded_at: row.responded_at,
  };
}

/**
 * Al finalizar el servicio: ningún ajuste puede quedar sin respuesta del cliente, y el total queda
 * fijo con los aprobados. Devuelve el total para guardarlo en total_amount.
 */
export async function closePriceForCompletion(
  executor: DbExecutor,
  requestId: bigint,
  agreedPrice: string | null,
): Promise<string> {
  const rows = await loadPriceAdjustments(executor, requestId);
  if (rows.some((row) => row.status === 'pendiente')) {
    throw new ConflictError(
      'El cliente todavía no responde un ajuste de precio. Espera su respuesta antes de finalizar.',
      'PRICE_ADJUSTMENT_PENDING',
    );
  }
  return computeTotalAmount(
    agreedPrice,
    rows.filter((row) => countsTowardTotal(row.status)).map((row) => row.amount),
  );
}
