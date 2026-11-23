import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { branches, commission_settings, income_records } from '../database/schema/tables.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../errors/app-error.ts';
import {
  MAX_COMMISSION_PERCENTAGE_HUNDREDTHS,
  currentCommission,
  serializeIncome,
} from './income.rules.ts';
import { centsToAmount, parseAmountToCents } from './price-adjustment.rules.ts';

interface Actor {
  id: string;
  role: string;
}

const COMMISSION_STATUSES = ['pendiente', 'pagada'] as const;

function parseId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError(`${field} no es un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

/** Fecha YYYY-MM-DD; `to` incluye todo ese día. */
function parseDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError(`${field} debe tener el formato AAAA-MM-DD.`, 'VALIDATION_ERROR');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${field} no es una fecha válida.`, 'VALIDATION_ERROR');
  }
  return date;
}

export interface IncomeQuery {
  branch_id?: unknown;
  commission_status?: unknown;
  from?: unknown;
  to?: unknown;
  page?: unknown;
  limit?: unknown;
}

/** Ingresos de la plataforma con filtros, más los totales de lo filtrado. */
export async function listIncome(query: IncomeQuery) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestError('page debe ser 1 o más y limit entre 1 y 100.', 'VALIDATION_ERROR');
  }

  const filters: SQL[] = [];
  if (query.branch_id !== undefined) {
    filters.push(eq(income_records.branch_id, parseId(query.branch_id, 'branch_id')));
  }
  if (query.commission_status !== undefined) {
    const status = query.commission_status;
    if (typeof status !== 'string' || !COMMISSION_STATUSES.includes(status as 'pendiente')) {
      throw new BadRequestError(
        `commission_status debe ser uno de: ${COMMISSION_STATUSES.join(', ')}.`,
        'VALIDATION_ERROR',
      );
    }
    filters.push(eq(income_records.commission_status, status as 'pendiente' | 'pagada'));
  }
  if (query.from !== undefined) {
    filters.push(gte(income_records.created_at, parseDate(query.from, 'from')));
  }
  if (query.to !== undefined) {
    const to = parseDate(query.to, 'to');
    filters.push(lt(income_records.created_at, new Date(to.getTime() + 24 * 60 * 60 * 1000)));
  }
  const where = filters.length ? and(...filters) : undefined;

  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      gross: sql<string>`coalesce(sum(${income_records.gross_amount}), 0)::numeric(14,2)::text`,
      commission: sql<string>`coalesce(sum(${income_records.commission_amount}), 0)::numeric(14,2)::text`,
      net: sql<string>`coalesce(sum(${income_records.net_amount}), 0)::numeric(14,2)::text`,
      pending: sql<string>`coalesce(sum(${income_records.commission_amount}) filter (where ${income_records.commission_status} = 'pendiente'), 0)::numeric(14,2)::text`,
    })
    .from(income_records)
    .where(where);
  const rows = await db
    .select({ income: income_records, branch: branches.name })
    .from(income_records)
    .innerJoin(branches, eq(income_records.branch_id, branches.UniqueID))
    .where(where)
    .orderBy(desc(income_records.created_at), desc(income_records.UniqueID))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(totals?.count ?? 0);
  return {
    data: rows.map((row) => ({ ...serializeIncome(row.income), branch_name: row.branch })),
    totals: {
      gross_amount: totals?.gross ?? '0.00',
      commission_amount: totals?.commission ?? '0.00',
      net_amount: totals?.net ?? '0.00',
      commission_pending: totals?.pending ?? '0.00',
    },
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

/** El proveedor pagó la comisión de un ingreso: queda liquidado. */
export async function markCommissionPaid(incomeId: bigint) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [income] = await tx
      .select()
      .from(income_records)
      .where(eq(income_records.UniqueID, incomeId))
      .for('update')
      .limit(1);
    if (!income) throw new NotFoundError('El ingreso no existe.');
    if (income.commission_status === 'pagada') {
      throw new ConflictError(
        'La comisión de este ingreso ya está pagada.',
        'COMMISSION_ALREADY_PAID',
      );
    }
    const [updated] = await tx
      .update(income_records)
      .set({
        commission_status: 'pagada',
        commission_paid_at: now,
        status: 'liquidado',
        settled_at: now,
      })
      .where(eq(income_records.UniqueID, incomeId))
      .returning();
    return serializeIncome(updated);
  });
}

/** Porcentaje vigente y los cambios anteriores, más recientes primero. */
export async function getCommissionSettings() {
  const current = await currentCommission(db);
  const history = await db
    .select()
    .from(commission_settings)
    .orderBy(desc(commission_settings.effective_from), desc(commission_settings.UniqueID))
    .limit(20);
  return {
    current,
    history: history.map((row) => ({
      id: row.UniqueID.toString(),
      percentage: row.percentage,
      effective_from: row.effective_from,
      created_by: row.created_by.toString(),
      created_at: row.created_at,
    })),
  };
}

/** Cambia el porcentaje desde ahora; los ingresos ya registrados conservan el suyo. */
export async function setCommissionPercentage(actor: Actor, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = rawBody as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => key !== 'percentage');
  if (unknown.length) {
    throw new BadRequestError(`Campos no permitidos: ${unknown.join(', ')}.`, 'VALIDATION_ERROR');
  }
  const hundredths = parseAmountToCents(body.percentage);
  if (hundredths === null || hundredths > MAX_COMMISSION_PERCENTAGE_HUNDREDTHS) {
    throw new BadRequestError(
      `percentage debe ir de 0 a ${centsToAmount(MAX_COMMISSION_PERCENTAGE_HUNDREDTHS)}, con máximo 2 decimales.`,
      'VALIDATION_ERROR',
    );
  }
  const [row] = await db
    .insert(commission_settings)
    .values({
      percentage: centsToAmount(hundredths),
      effective_from: new Date(),
      created_by: BigInt(actor.id),
    })
    .returning();
  return {
    id: row.UniqueID.toString(),
    percentage: row.percentage,
    effective_from: row.effective_from,
    created_by: row.created_by.toString(),
  };
}
