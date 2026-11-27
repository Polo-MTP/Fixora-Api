import { and, eq, exists, gte, inArray, lt, not, sql, type SQL } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
  branches,
  business_supplier,
  employees,
  request_dispatches,
  reviews,
  service_request_events,
  service_requests,
  suppliers,
} from '../database/schema/tables.ts';
import { BadRequestError } from '../errors/app-error.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import { employeeProfileService } from './employee-profile.service.ts';
import { checkBranchAccess } from './portfolio.service.ts';
import {
  acceptanceRate,
  acceptedResponseSeconds,
  averageSeconds,
  countResponses,
  parseStatsPeriod,
  responseSeconds,
  roundRating,
} from './provider-stats.rules.ts';
import { addDays, localDateTimeToUtc } from '../utils/timezone.ts';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/**
 * API-44: estadísticas del proveedor por periodo y sucursal: solicitudes recibidas, aceptadas,
 * rechazadas y vencidas, porcentaje de aceptación, tiempo de respuesta promedio, servicios
 * completados, cancelaciones del proveedor y calificación.
 */

interface StatsScope {
  branchIds: bigint[];
  /** Técnicos que cuentan; con [byEmployee] las solicitudes se filtran por técnico, no por sucursal. */
  employeeIds: bigint[];
  byEmployee: boolean;
}

function parseId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError(`${field} no es un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

/** Todos los técnicos que han estado en esas sucursales, también los dados de baja: es historia. */
async function employeesOf(branchIds: bigint[]) {
  if (!branchIds.length) return [];
  const rows = await db
    .select({ id: employees.UniqueID })
    .from(employees)
    .where(inArray(employees.branch_id, branchIds));
  return rows.map((row) => row.id);
}

/**
 * De quién son las estadísticas: un técnico ([employee_id]), una sucursal ([branch_id]) o, sin
 * parámetros, todas las sucursales del dueño, la del gerente o las del propio técnico.
 */
async function resolveScope(
  actor: Actor,
  query: { employee_id?: unknown; branch_id?: unknown },
): Promise<StatsScope> {
  if (query.employee_id !== undefined) {
    const employeeId = parseId(query.employee_id, 'employee_id');
    const access = await employeeProfileService.checkEmployeeAccess(
      employeeId,
      actor as AuthenticatedUser,
    );
    return { branchIds: [access.branchId], employeeIds: [employeeId], byEmployee: true };
  }
  if (query.branch_id !== undefined) {
    const branchId = parseId(query.branch_id, 'branch_id');
    await checkBranchAccess(branchId, actor as AuthenticatedUser);
    return { branchIds: [branchId], employeeIds: await employeesOf([branchId]), byEmployee: false };
  }

  const userId = BigInt(actor.id);
  if (actor.role === 'proveedor') {
    const owned = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .innerJoin(business_supplier, eq(business_supplier.business_id, branches.business_id))
      .innerJoin(suppliers, eq(suppliers.UniqueID, business_supplier.supplier_id))
      .where(and(eq(suppliers.user_id, userId), eq(business_supplier.active, true)));
    const branchIds = owned.map((row) => row.id);
    if (branchIds.length) {
      return { branchIds, employeeIds: await employeesOf(branchIds), byEmployee: false };
    }
  }

  const own = await db
    .select({ id: employees.UniqueID, branchId: employees.branch_id })
    .from(employees)
    .where(and(eq(employees.user_id, userId), eq(employees.active, true)));
  if (!own.length) {
    throw new BadRequestError(
      'Tu cuenta no tiene sucursales ni atiende servicios: indica branch_id.',
      'STATS_SCOPE_REQUIRED',
    );
  }
  const branchIds = [...new Set(own.map((row) => row.branchId.toString()))].map(BigInt);
  if (actor.role === 'gerente') {
    return { branchIds, employeeIds: await employeesOf(branchIds), byEmployee: false };
  }
  return { branchIds, employeeIds: own.map((row) => row.id), byEmployee: true };
}

/** Condición sobre service_requests: del técnico o de la sucursal, según el alcance. */
function requestInScope(scope: StatsScope): SQL {
  if (scope.byEmployee) {
    return scope.employeeIds.length
      ? inArray(service_requests.employee_id, scope.employeeIds)
      : sql`false`;
  }
  return inArray(service_requests.branch_id, scope.branchIds);
}

/** GET /api/stats */
export async function getProviderStats(
  actor: Actor,
  query: { from?: unknown; to?: unknown; employee_id?: unknown; branch_id?: unknown },
) {
  const scope = await resolveScope(actor, query);
  const branchRows = await db
    .select({ id: branches.UniqueID, name: branches.name, timezone: branches.timezone })
    .from(branches)
    .where(inArray(branches.UniqueID, scope.branchIds));
  const timeZone = branchRows[0]?.timezone ?? 'America/Mexico_City';
  const period = parseStatsPeriod(query, timeZone);
  const start = localDateTimeToUtc(period.from, '00:00', timeZone);
  const end = localDateTimeToUtc(addDays(period.to, 1), '00:00', timeZone);
  const inScope = requestInScope(scope);

  // Aceptadas en el periodo, con cuándo le llegó el aviso si era emergencia.
  const acceptedRows = await db
    .select({
      isEmergency: service_requests.is_emergency,
      createdAt: service_requests.created_at,
      acceptedAt: service_requests.accepted_at,
      notifiedAt: sql<Date | null>`(
        select ${request_dispatches.notified_at} from ${request_dispatches}
        where ${request_dispatches.request_id} = ${service_requests.UniqueID}
          and ${request_dispatches.response} = 'acepto'
        limit 1
      )`,
    })
    .from(service_requests)
    .where(
      and(inScope, gte(service_requests.accepted_at, start), lt(service_requests.accepted_at, end)),
    );
  const accepted = acceptedRows.map((row) => ({
    ...row,
    acceptedAt: row.acceptedAt!,
    notifiedAt: row.notifiedAt ? new Date(row.notifiedAt) : null,
  }));

  // Rechazos y emergencias vencidas de los técnicos en el periodo.
  const responses = scope.employeeIds.length
    ? await db
        .select({
          response: request_dispatches.response,
          notifiedAt: request_dispatches.notified_at,
          respondedAt: request_dispatches.responded_at,
          isEmergency: service_requests.is_emergency,
          requestCreatedAt: service_requests.created_at,
        })
        .from(request_dispatches)
        .innerJoin(service_requests, eq(service_requests.UniqueID, request_dispatches.request_id))
        .where(
          and(
            inArray(request_dispatches.employee_id, scope.employeeIds),
            inArray(request_dispatches.response, ['rechazo', 'expiro']),
            gte(request_dispatches.responded_at, start),
            lt(request_dispatches.responded_at, end),
          ),
        )
    : [];
  const dispatchRows = responses.map((row) => ({ ...row, response: row.response! }));
  const counts = countResponses(dispatchRows);

  // Solicitudes normales que vencieron sin que nadie respondiera: no dejan registro de respuesta.
  const [expiredNormal] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(service_requests)
    .where(
      and(
        inScope,
        eq(service_requests.is_emergency, false),
        eq(service_requests.status, 'expirada'),
        gte(service_requests.expires_at, start),
        lt(service_requests.expires_at, end),
        not(
          exists(
            db
              .select({ id: request_dispatches.UniqueID })
              .from(request_dispatches)
              .where(eq(request_dispatches.request_id, service_requests.UniqueID)),
          ),
        ),
      ),
    );
  const expired = counts.expired + Number(expiredNormal?.total ?? 0);

  // Recibidas: normales creadas en el periodo y emergencias que les avisaron en el periodo.
  const [normalReceived] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(service_requests)
    .where(
      and(
        inScope,
        eq(service_requests.is_emergency, false),
        gte(service_requests.created_at, start),
        lt(service_requests.created_at, end),
      ),
    );
  const [emergencyReceived] = scope.employeeIds.length
    ? await db
        .select({ total: sql<number>`count(distinct ${request_dispatches.request_id})::int` })
        .from(request_dispatches)
        .innerJoin(service_requests, eq(service_requests.UniqueID, request_dispatches.request_id))
        .where(
          and(
            eq(service_requests.is_emergency, true),
            inArray(request_dispatches.employee_id, scope.employeeIds),
            gte(request_dispatches.notified_at, start),
            lt(request_dispatches.notified_at, end),
          ),
        )
    : [{ total: 0 }];

  const [completed] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(service_requests)
    .where(
      and(
        inScope,
        eq(service_requests.status, 'completada'),
        gte(service_requests.completed_at, start),
        lt(service_requests.completed_at, end),
      ),
    );

  const [canceledByProvider] = await db
    .select({ total: sql<number>`count(distinct ${service_requests.UniqueID})::int` })
    .from(service_requests)
    .innerJoin(
      service_request_events,
      eq(service_request_events.request_id, service_requests.UniqueID),
    )
    .where(
      and(
        inScope,
        eq(service_requests.status, 'cancelada'),
        eq(service_requests.canceled_by, 'proveedor'),
        eq(service_request_events.to_status, 'cancelada'),
        gte(service_request_events.created_at, start),
        lt(service_request_events.created_at, end),
      ),
    );

  // Calificación que dieron los clientes: la del periodo y la de siempre.
  const ratingQuery = (fromDate?: Date) =>
    db
      .select({
        average: sql<string | null>`avg(${reviews.rating})`,
        total: sql<number>`count(*)::int`,
      })
      .from(reviews)
      .innerJoin(service_requests, eq(service_requests.UniqueID, reviews.request_id))
      .where(
        and(
          inScope,
          eq(reviews.direction, 'cliente_a_proveedor'),
          eq(reviews.status, 'publicada'),
          fromDate ? gte(reviews.created_at, fromDate) : undefined,
          fromDate ? lt(reviews.created_at, end) : undefined,
        ),
      );
  const [periodRating] = await ratingQuery(start);
  const [overallRating] = await ratingQuery();

  return {
    scope: {
      branches: branchRows.map((row) => ({ id: row.id.toString(), name: row.name })),
      employee_id:
        scope.byEmployee && scope.employeeIds.length === 1
          ? scope.employeeIds[0]!.toString()
          : null,
    },
    period: { from: period.from, to: period.to, timezone: timeZone },
    requests: {
      received: Number(normalReceived?.total ?? 0) + Number(emergencyReceived?.total ?? 0),
      accepted: accepted.length,
      rejected: counts.rejected,
      expired_without_response: expired,
      completed: Number(completed?.total ?? 0),
      canceled_by_provider: Number(canceledByProvider?.total ?? 0),
    },
    acceptance_rate: acceptanceRate(accepted.length, counts.rejected, expired),
    avg_response_seconds: averageSeconds([
      ...accepted.map(acceptedResponseSeconds),
      ...dispatchRows.map(responseSeconds),
    ]),
    rating: {
      period_average: roundRating(periodRating?.average, Number(periodRating?.total ?? 0)),
      period_count: Number(periodRating?.total ?? 0),
      overall_average: roundRating(overallRating?.average, Number(overallRating?.total ?? 0)),
      overall_count: Number(overallRating?.total ?? 0),
    },
  };
}
