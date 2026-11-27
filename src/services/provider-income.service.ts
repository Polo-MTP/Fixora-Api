import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
  branches,
  categories,
  income_records,
  personal_data,
  service_requests,
} from '../database/schema/tables.ts';
import { BadRequestError } from '../errors/app-error.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import { managedBranchIds } from './provider-scope.ts';
import { parseStatsPeriod } from './provider-stats.rules.ts';
import { addDays, localDateTimeToUtc } from '../utils/timezone.ts';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/**
 * API-46: ingresos del proveedor, agrupados por servicio. Cada pago confirmado deja un
 * income_records con bruto, comisión y neto (API-38); un servicio puede tener varios pagos.
 *
 * Con efectivo o transferencia el proveedor recibe todo y le debe la comisión a la plataforma
 * (commission_status pendiente). El ingreso queda liquidado (status liquidado) cuando se registra
 * esa comisión como pagada.
 */

const COMMISSION_STATUSES = ['pendiente', 'pagada'] as const;

type MoneyColumn =
  | typeof income_records.gross_amount
  | typeof income_records.commission_amount
  | typeof income_records.net_amount;

/** Suma con dos decimales como texto, igual que el listado del administrador. */
function money(column: MoneyColumn) {
  return sql<string>`coalesce(sum(${column}), 0)::numeric(14,2)::text`;
}

/** Suma solo de las filas que cumplen [condition]. */
function moneyWhere(column: MoneyColumn, condition: SQL) {
  return sql<string>`coalesce(sum(${column}) filter (where ${condition}), 0)::numeric(14,2)::text`;
}

export interface ProviderIncomeQuery {
  branch_id?: unknown;
  from?: unknown;
  to?: unknown;
  commission_status?: unknown;
  page?: unknown;
  limit?: unknown;
}

/** GET /api/income: lista por servicio y totales de lo filtrado. */
export async function listProviderIncome(actor: Actor, query: ProviderIncomeQuery) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestError('page debe ser 1 o más y limit entre 1 y 100.', 'VALIDATION_ERROR');
  }

  const branchIds = await managedBranchIds(actor, query.branch_id);
  const branchRows = await db
    .select({ id: branches.UniqueID, name: branches.name, timezone: branches.timezone })
    .from(branches)
    .where(inArray(branches.UniqueID, branchIds));
  const timeZone = branchRows[0]?.timezone ?? 'America/Mexico_City';

  const filters: SQL[] = [inArray(income_records.branch_id, branchIds)];
  // Sin fechas se ve todo; con alguna, el periodo en la zona de la sucursal (como en API-44).
  let period: { from: string; to: string } | null = null;
  if ((query.from ?? '') !== '' || (query.to ?? '') !== '') {
    period = parseStatsPeriod(query, timeZone);
    filters.push(
      gte(income_records.created_at, localDateTimeToUtc(period.from, '00:00', timeZone)),
    );
    filters.push(
      lt(income_records.created_at, localDateTimeToUtc(addDays(period.to, 1), '00:00', timeZone)),
    );
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
  const where = and(...filters);

  const pendingCommission = sql`${income_records.commission_status} = 'pendiente'`;
  const notSettled = sql`${income_records.status} = 'pendiente'`;
  const [totals] = await db
    .select({
      services: sql<number>`count(distinct ${income_records.request_id})::int`,
      payments: sql<number>`count(*)::int`,
      gross: money(income_records.gross_amount),
      commission: money(income_records.commission_amount),
      net: money(income_records.net_amount),
      commissionOwed: moneyWhere(income_records.commission_amount, pendingCommission),
      pendingSettlement: moneyWhere(income_records.net_amount, notSettled),
    })
    .from(income_records)
    .where(where);

  const rows = await db
    .select({
      requestId: income_records.request_id,
      branchId: income_records.branch_id,
      branchName: branches.name,
      category: categories.name,
      completedAt: service_requests.completed_at,
      clientName: service_requests.client_name,
      clientId: service_requests.client_id,
      payments: sql<number>`count(*)::int`,
      gross: money(income_records.gross_amount),
      commission: money(income_records.commission_amount),
      net: money(income_records.net_amount),
      commissionOwed: moneyWhere(income_records.commission_amount, pendingCommission),
      firstPaymentAt: sql<Date>`min(${income_records.created_at})`,
      lastPaymentAt: sql<Date>`max(${income_records.created_at})`,
      anyNotSettled: sql<boolean>`bool_or(${notSettled})`,
    })
    .from(income_records)
    .innerJoin(service_requests, eq(service_requests.UniqueID, income_records.request_id))
    .innerJoin(categories, eq(categories.UniqueID, service_requests.category_id))
    .innerJoin(branches, eq(branches.UniqueID, income_records.branch_id))
    .where(where)
    .groupBy(
      income_records.request_id,
      income_records.branch_id,
      branches.name,
      categories.name,
      service_requests.completed_at,
      service_requests.client_name,
      service_requests.client_id,
    )
    .orderBy(desc(sql`max(${income_records.created_at})`), desc(income_records.request_id))
    .limit(limit)
    .offset((page - 1) * limit);

  // Nombre del cliente: el guardado al aceptar (API-55) o, en servicios anteriores, el actual.
  const missing = [...new Set(rows.filter((r) => !r.clientName).map((r) => r.clientId))];
  const names = missing.length
    ? await db
        .select({
          userId: personal_data.user_id,
          name: personal_data.name,
          last: personal_data.lastname_p,
        })
        .from(personal_data)
        .where(inArray(personal_data.user_id, missing))
    : [];
  const nameById = new Map(names.map((n) => [n.userId.toString(), `${n.name} ${n.last}`.trim()]));

  const total = Number(totals?.services ?? 0);
  return {
    branches: branchRows.map((row) => ({ id: row.id.toString(), name: row.name })),
    period: period ? { ...period, timezone: timeZone } : null,
    totals: {
      services: total,
      payments: Number(totals?.payments ?? 0),
      gross_amount: totals?.gross ?? '0.00',
      commission_amount: totals?.commission ?? '0.00',
      net_amount: totals?.net ?? '0.00',
      commission_owed: totals?.commissionOwed ?? '0.00',
      pending_settlement: totals?.pendingSettlement ?? '0.00',
    },
    data: rows.map((row) => ({
      request_id: row.requestId.toString(),
      branch: { id: row.branchId.toString(), name: row.branchName },
      category: row.category,
      client_name: row.clientName ?? nameById.get(row.clientId.toString()) ?? '',
      completed_at: row.completedAt,
      payments: row.payments,
      gross_amount: row.gross,
      commission_amount: row.commission,
      net_amount: row.net,
      commission_owed: row.commissionOwed,
      settled: !row.anyNotSettled,
      first_payment_at: new Date(row.firstPaymentAt).toISOString(),
      last_payment_at: new Date(row.lastPaymentAt).toISOString(),
    })),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}
