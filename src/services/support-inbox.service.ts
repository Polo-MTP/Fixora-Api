import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  personal_data,
  report_attachments,
  reports,
  reports_events,
  roles,
  users,
} from '../database/schema/tables.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import {
  isReportClosed,
  isStaffRole,
  parseChangeStatusInput,
  parseReportId,
} from '../utils/report-validation.ts';
import {
  INBOX_OVERDUE_HOURS,
  buildResolveBody,
  isOverdue,
  parseInboxQuery,
  reportAgeHours,
} from '../utils/support-validation.ts';
import { assignReport, changeReportStatus } from './report.service.ts';

interface Actor {
  id: string;
  role: string;
}

const LIST_DESCRIPTION_PREVIEW = 140;

export function assertSupportStaff(actor: Actor): void {
  if (!isStaffRole(actor.role)) {
    throw new ForbiddenError(
      'No tienes permisos para realizar esta acción.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
}

export interface DirectoryEntry {
  name: string | null;
  role: string | null;
}

/** Nombre y rol de un conjunto de usuarios, en dos consultas. */
export async function loadUserDirectory(userIds: bigint[]): Promise<Map<string, DirectoryEntry>> {
  const unique = [...new Set(userIds)];
  const directory = new Map<string, DirectoryEntry>();
  if (!unique.length) return directory;

  const [names, roleRows] = await Promise.all([
    db
      .select({
        userId: personal_data.user_id,
        name: personal_data.name,
        lastname: personal_data.lastname_p,
      })
      .from(personal_data)
      .where(inArray(personal_data.user_id, unique)),
    db
      .select({ userId: users.UniqueID, role: roles.name })
      .from(users)
      .leftJoin(roles, eq(users.role_id, roles.UniqueID))
      .where(inArray(users.UniqueID, unique)),
  ]);

  for (const row of roleRows) {
    directory.set(row.userId.toString(), { name: null, role: row.role });
  }
  for (const row of names) {
    const full = [row.name, row.lastname].filter(Boolean).join(' ').trim() || null;
    const current = directory.get(row.userId.toString());
    directory.set(row.userId.toString(), { name: full, role: current?.role ?? null });
  }
  return directory;
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------

/** Abiertos primero y, entre ellos, por prioridad: urgente, alta, media y baja. */
const closedRank = sql`case when ${reports.status} in ('resuelto', 'rechazado') then 1 else 0 end`;
const priorityRank = sql`case ${reports.priority} when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end`;

async function inboxSummary(actor: Actor, now: Date) {
  const open = sql`${reports.status} in ('pendiente', 'en_revision')`;
  const overdueBefore = new Date(now.getTime() - INBOX_OVERDUE_HOURS * 60 * 60 * 1000);

  const [row] = await db
    .select({
      pendiente: sql<number>`count(*) filter (where ${reports.status} = 'pendiente')::int`,
      enRevision: sql<number>`count(*) filter (where ${reports.status} = 'en_revision')::int`,
      resuelto: sql<number>`count(*) filter (where ${reports.status} = 'resuelto')::int`,
      rechazado: sql<number>`count(*) filter (where ${reports.status} = 'rechazado')::int`,
      unassignedOpen: sql<number>`count(*) filter (where ${open} and ${reports.assigned_to} is null)::int`,
      mineOpen: sql<number>`count(*) filter (where ${open} and ${reports.assigned_to} = ${actor.id}::bigint)::int`,
      urgentOpen: sql<number>`count(*) filter (where ${open} and ${reports.priority} = 'urgente')::int`,
      overdueOpen: sql<number>`count(*) filter (where ${open} and ${reports.created_at} < ${overdueBefore.toISOString()}::timestamp)::int`,
    })
    .from(reports);

  const pendiente = Number(row?.pendiente ?? 0);
  const enRevision = Number(row?.enRevision ?? 0);
  return {
    by_status: {
      pendiente,
      en_revision: enRevision,
      resuelto: Number(row?.resuelto ?? 0),
      rechazado: Number(row?.rechazado ?? 0),
    },
    open_total: pendiente + enRevision,
    unassigned_open: Number(row?.unassignedOpen ?? 0),
    mine_open: Number(row?.mineOpen ?? 0),
    urgent_open: Number(row?.urgentOpen ?? 0),
    overdue_open: Number(row?.overdueOpen ?? 0),
    overdue_after_hours: INBOX_OVERDUE_HOURS,
  };
}

/**
 * GET /api/support/inbox — bandeja de reportes, garantías y reclamaciones para Soporte.
 * Trae los conteos de la bandeja (que no dependen de los filtros) y la página de casos.
 */
export async function listInbox(actor: Actor, rawQuery: unknown) {
  assertSupportStaff(actor);
  const query = parseInboxQuery((rawQuery ?? {}) as Record<string, unknown>);
  const actorId = BigInt(actor.id);
  const now = new Date();

  const where = and(
    query.status ? inArray(reports.status, query.status) : undefined,
    query.type ? eq(reports.type, query.type) : undefined,
    query.category ? eq(reports.category, query.category) : undefined,
    query.priority ? eq(reports.priority, query.priority) : undefined,
    query.request_id !== null ? eq(reports.request_id, query.request_id) : undefined,
    query.assigned === 'me'
      ? eq(reports.assigned_to, actorId)
      : query.assigned === 'unassigned'
        ? isNull(reports.assigned_to)
        : query.assigned !== null
          ? eq(reports.assigned_to, query.assigned)
          : undefined,
    query.q
      ? or(
          like(reports.folio, `${query.q}%`),
          /^\d{1,18}$/.test(query.q) ? eq(reports.request_id, BigInt(query.q)) : undefined,
        )
      : undefined,
    query.created_from ? gte(reports.created_at, query.created_from) : undefined,
    query.created_before ? lt(reports.created_at, query.created_before) : undefined,
  );

  const orderBy =
    query.sort === 'antiguedad'
      ? [asc(reports.created_at), asc(reports.UniqueID)]
      : query.sort === 'actividad'
        ? [desc(reports.updated_at), desc(reports.UniqueID)]
        : [asc(closedRank), asc(priorityRank), asc(reports.created_at), asc(reports.UniqueID)];

  const [summary, [countRow], rows] = await Promise.all([
    inboxSummary(actor, now),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(reports)
      .where(where),
    db
      .select()
      .from(reports)
      .where(where)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
  ]);

  const reportIds = rows.map((row) => row.UniqueID);
  const people = rows.flatMap((row) =>
    [row.reporter_id, row.reported_id, row.assigned_to].filter((id): id is bigint => id !== null),
  );

  const [directory, evidenceRows, commentRows] = await Promise.all([
    loadUserDirectory(people),
    reportIds.length
      ? db
          .select({
            reportId: report_attachments.report_id,
            total: sql<number>`count(*)::int`,
          })
          .from(report_attachments)
          .where(inArray(report_attachments.report_id, reportIds))
          .groupBy(report_attachments.report_id)
      : Promise.resolve([]),
    reportIds.length
      ? db
          .select({ reportId: reports_events.report_id, total: sql<number>`count(*)::int` })
          .from(reports_events)
          .where(
            and(
              inArray(reports_events.report_id, reportIds),
              eq(reports_events.type, 'comentario'),
            ),
          )
          .groupBy(reports_events.report_id)
      : Promise.resolve([]),
  ]);
  const evidenceById = new Map(evidenceRows.map((row) => [row.reportId.toString(), row.total]));
  const commentsById = new Map(commentRows.map((row) => [row.reportId.toString(), row.total]));

  const person = (id: bigint | null) =>
    id === null
      ? null
      : {
          id: id.toString(),
          name: directory.get(id.toString())?.name ?? null,
          role: directory.get(id.toString())?.role ?? null,
        };

  const total = Number(countRow?.total ?? 0);
  return {
    summary,
    items: rows.map((row) => ({
      id: row.UniqueID.toString(),
      folio: row.folio,
      type: row.type,
      category: row.category,
      priority: row.priority,
      status: row.status,
      request_id: row.request_id?.toString() ?? null,
      description:
        row.description.length > LIST_DESCRIPTION_PREVIEW
          ? `${row.description.slice(0, LIST_DESCRIPTION_PREVIEW - 3)}...`
          : row.description,
      reporter: person(row.reporter_id),
      reported: person(row.reported_id),
      assigned_to: person(row.assigned_to),
      evidence_count: evidenceById.get(row.UniqueID.toString()) ?? 0,
      comments_count: commentsById.get(row.UniqueID.toString()) ?? 0,
      age_hours: reportAgeHours(row.created_at, now),
      overdue: isOverdue(row.status, row.created_at, now),
      resolution_type: row.resolution_type,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}

/** POST /api/support/inbox/:id/assign — Soporte toma el caso; un Administrador puede asignarlo a otra persona. */
export async function assignFromInbox(actor: Actor, rawId: unknown, rawBody: unknown) {
  assertSupportStaff(actor);
  return assignReport(parseReportId(rawId, 'id'), actor, rawBody);
}

/**
 * POST /api/support/inbox/:id/resolve — resuelve el caso con un tipo de resolución y un comentario.
 * Si el caso aún está pendiente, primero lo pasa a revisión (y queda asignado a quien lo resuelve),
 * de modo que un solo clic en la bandeja deja la bitácora completa.
 */
export async function resolveFromInbox(actor: Actor, rawId: unknown, rawBody: unknown) {
  assertSupportStaff(actor);
  const reportId = parseReportId(rawId, 'id');

  // Se valida todo antes de mover nada, para no dejar el caso a medias si el cuerpo es inválido.
  const body = buildResolveBody(rawBody);
  parseChangeStatusInput(body);

  const [report] = await db
    .select({ status: reports.status })
    .from(reports)
    .where(eq(reports.UniqueID, reportId))
    .limit(1);
  if (!report) throw new NotFoundError('El reporte no existe.');
  if (isReportClosed(report.status)) {
    throw new ConflictError('El reporte ya está cerrado.', 'REPORT_CLOSED');
  }

  if (report.status === 'pendiente') {
    await changeReportStatus(reportId, actor, { status: 'en_revision' });
  }
  return changeReportStatus(reportId, actor, body);
}
