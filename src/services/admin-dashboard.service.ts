import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
  income_records,
  reports,
  service_requests,
  supplier_applications,
} from '../database/schema/tables.ts';
import { addDays, localDateTimeToUtc } from '../utils/timezone.ts';
import {
  OPEN_REPORT_STATUSES,
  PLATFORM_TIME_ZONE,
  countByStatus,
} from './admin-dashboard.rules.ts';
import { parseStatsPeriod } from './provider-stats.rules.ts';

/**
 * API-52: resumen del tablero del panel de administración. Lo pendiente (proveedores por aprobar,
 * reportes abiertos, comisiones por cobrar) es al momento; lo demás, del periodo.
 */

const money = (
  column: typeof income_records.commission_amount | typeof income_records.gross_amount,
) => sql<string>`coalesce(sum(${column}), 0)::numeric(14,2)::text`;

/** GET /api/admin/dashboard */
export async function getAdminDashboard(query: { from?: unknown; to?: unknown }) {
  const period = parseStatsPeriod(query, PLATFORM_TIME_ZONE);
  const start = localDateTimeToUtc(period.from, '00:00', PLATFORM_TIME_ZONE);
  const end = localDateTimeToUtc(addDays(period.to, 1), '00:00', PLATFORM_TIME_ZONE);

  // Proveedores: lo que espera revisión ahora y las solicitudes que llegaron en el periodo.
  const applications = await db
    .select({ state: supplier_applications.state, total: sql<number>`count(*)::int` })
    .from(supplier_applications)
    .groupBy(supplier_applications.state);
  const byState = new Map(applications.map((row) => [row.state, Number(row.total)]));
  const [receivedApplications] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(supplier_applications)
    .where(
      and(
        gte(supplier_applications.application_date, period.from),
        lte(supplier_applications.application_date, period.to),
      ),
    );

  // Servicios creados en el periodo, por estado.
  const serviceRows = await db
    .select({ status: service_requests.status, total: sql<number>`count(*)::int` })
    .from(service_requests)
    .where(and(gte(service_requests.created_at, start), lt(service_requests.created_at, end)))
    .groupBy(service_requests.status);
  const [emergencies] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(service_requests)
    .where(
      and(
        eq(service_requests.is_emergency, true),
        gte(service_requests.created_at, start),
        lt(service_requests.created_at, end),
      ),
    );

  // Reportes: los abiertos ahora (por prioridad) y los que se levantaron en el periodo.
  const openReports = await db
    .select({ priority: reports.priority, total: sql<number>`count(*)::int` })
    .from(reports)
    .where(inArray(reports.status, [...OPEN_REPORT_STATUSES]))
    .groupBy(reports.priority);
  const [newReports] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reports)
    .where(and(gte(reports.created_at, start), lt(reports.created_at, end)));
  const openByPriority = { baja: 0, media: 0, alta: 0, urgente: 0 } as Record<string, number>;
  for (const row of openReports) openByPriority[row.priority] = Number(row.total);

  // Comisiones de los cobros del periodo, y lo que los proveedores deben en total.
  const [commissions] = await db
    .select({
      payments: sql<number>`count(*)::int`,
      gross: money(income_records.gross_amount),
      commission: money(income_records.commission_amount),
      paid: sql<string>`coalesce(sum(${income_records.commission_amount}) filter (where ${income_records.commission_status} = 'pagada'), 0)::numeric(14,2)::text`,
      pending: sql<string>`coalesce(sum(${income_records.commission_amount}) filter (where ${income_records.commission_status} = 'pendiente'), 0)::numeric(14,2)::text`,
    })
    .from(income_records)
    .where(and(gte(income_records.created_at, start), lt(income_records.created_at, end)));
  const [owed] = await db
    .select({ pending: money(income_records.commission_amount) })
    .from(income_records)
    .where(eq(income_records.commission_status, 'pendiente'));

  return {
    period: { ...period, timezone: PLATFORM_TIME_ZONE },
    suppliers: {
      pending_review: byState.get('pendiente') ?? 0,
      awaiting_documents: byState.get('documentacion_incompleta') ?? 0,
      approved_total: byState.get('aprobada') ?? 0,
      received_in_period: Number(receivedApplications?.total ?? 0),
    },
    services: {
      ...countByStatus(serviceRows),
      emergencies: Number(emergencies?.total ?? 0),
    },
    reports: {
      open: Object.values(openByPriority).reduce((sum, value) => sum + value, 0),
      open_by_priority: openByPriority,
      created_in_period: Number(newReports?.total ?? 0),
    },
    commissions: {
      payments: Number(commissions?.payments ?? 0),
      gross_amount: commissions?.gross ?? '0.00',
      commission_amount: commissions?.commission ?? '0.00',
      commission_paid: commissions?.paid ?? '0.00',
      commission_pending: commissions?.pending ?? '0.00',
      pending_total: owed?.pending ?? '0.00',
    },
  };
}
