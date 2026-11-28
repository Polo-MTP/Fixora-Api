import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { ENV } from '../config/env.ts';
import { db } from '../config/database.ts';
import { account_sanctions, reports, roles, users } from '../database/schema/tables.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { SanctionAppliedEvent, SanctionLiftedEvent } from '../events/events/domain-events.ts';
import { isStaffRole } from '../utils/report-validation.ts';
import {
  MARK_TYPES,
  autoMarkReason,
  buildClientAlertMessage,
  formatSanctionDate,
  parseApplySanctionInput,
  parseLiftSanctionInput,
  parseSanctionId,
  parseSanctionListQuery,
  sanctionStatus,
  shouldAutoMark,
} from '../utils/sanction-validation.ts';

type SanctionRow = typeof account_sanctions.$inferSelect;

interface Actor {
  id: string;
  role: string;
}

function assertStaff(actor: Actor): void {
  if (!isStaffRole(actor.role)) {
    throw new ForbiddenError(
      'No tienes permisos para realizar esta acción.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
}

/** Vigente: activa, ya empezó y no ha vencido. */
function currentCondition(now: Date) {
  return and(
    eq(account_sanctions.active, true),
    lte(account_sanctions.starts_at, now),
    or(isNull(account_sanctions.ends_at), gt(account_sanctions.ends_at, now)),
  );
}

function serializeSanction(row: SanctionRow, now: Date = new Date()) {
  return {
    id: row.UniqueID.toString(),
    user_id: row.user_id.toString(),
    report_id: row.report_id?.toString() ?? null,
    type: row.type,
    reason: row.reason,
    status: sanctionStatus(row, now),
    source: row.source,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at ? row.ends_at.toISOString() : null,
    created_by: row.created_by.toString(),
    created_at: row.created_at.toISOString(),
    lifted_at: row.lifted_at ? row.lifted_at.toISOString() : null,
    lifted_by: row.lifted_by?.toString() ?? null,
    lift_reason: row.lift_reason,
  };
}

async function findSanction(id: bigint): Promise<SanctionRow> {
  const [row] = await db
    .select()
    .from(account_sanctions)
    .where(eq(account_sanctions.UniqueID, id))
    .limit(1);
  if (!row) throw new NotFoundError('La sanción no existe.');
  return row;
}

// ---------------------------------------------------------------------------
// Aplicar, consultar y retirar (Soporte y Administrador)
// ---------------------------------------------------------------------------

/** POST /api/sanctions */
export async function applySanction(actor: Actor, rawBody: unknown) {
  assertStaff(actor);
  const input = parseApplySanctionInput(rawBody);
  const actorId = BigInt(actor.id);

  const [target] = await db
    .select({ id: users.UniqueID, role: roles.name })
    .from(users)
    .leftJoin(roles, eq(users.role_id, roles.UniqueID))
    .where(eq(users.UniqueID, input.user_id))
    .limit(1);
  if (!target) throw new NotFoundError('El usuario no existe.');
  if (target.id === actorId || (target.role && isStaffRole(target.role))) {
    throw new ForbiddenError(
      'No se puede sancionar a personal de Soporte o Administración.',
      'SANCTION_TARGET_FORBIDDEN',
    );
  }

  if (input.report_id !== null) {
    const [report] = await db
      .select({ id: reports.UniqueID, reportedId: reports.reported_id })
      .from(reports)
      .where(eq(reports.UniqueID, input.report_id))
      .limit(1);
    if (!report) throw new NotFoundError('El reporte no existe.');
    if (report.reportedId !== input.user_id) {
      throw new ConflictError('El reporte no señala a ese usuario.', 'REPORT_USER_MISMATCH');
    }
  }

  const now = new Date();
  const [existing] = await db
    .select({ id: account_sanctions.UniqueID })
    .from(account_sanctions)
    .where(
      and(
        eq(account_sanctions.user_id, input.user_id),
        eq(account_sanctions.type, input.type),
        currentCondition(now),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ConflictError(
      'El usuario ya tiene una sanción vigente de ese tipo. Retírala antes de aplicar otra.',
      'SANCTION_ALREADY_ACTIVE',
    );
  }

  const [created] = await db
    .insert(account_sanctions)
    .values({
      user_id: input.user_id,
      report_id: input.report_id,
      type: input.type,
      reason: input.reason,
      starts_at: now,
      ends_at: input.ends_at,
      created_by: actorId,
      source: 'manual',
    })
    .returning();

  await eventBus.notify(
    new SanctionAppliedEvent({
      sanctionId: created!.UniqueID.toString(),
      userId: input.user_id.toString(),
      type: input.type,
      reason: input.reason,
      endsAt: input.ends_at ? input.ends_at.toISOString() : null,
      source: 'manual',
      appliedBy: actor.id,
      reportId: input.report_id?.toString() ?? null,
    }),
  );

  return serializeSanction(created!, now);
}

/** GET /api/sanctions — con filtros y paginación. */
export async function listSanctions(actor: Actor, rawQuery: unknown) {
  assertStaff(actor);
  const query = parseSanctionListQuery((rawQuery ?? {}) as Record<string, unknown>);
  const now = new Date();

  const statusCondition =
    query.status === 'vigente'
      ? currentCondition(now)
      : query.status === 'retirada'
        ? eq(account_sanctions.active, false)
        : query.status === 'vencida'
          ? and(
              eq(account_sanctions.active, true),
              isNotNull(account_sanctions.ends_at),
              lte(account_sanctions.ends_at, now),
            )
          : undefined;

  const where = and(
    query.user_id !== null ? eq(account_sanctions.user_id, query.user_id) : undefined,
    query.type ? eq(account_sanctions.type, query.type) : undefined,
    statusCondition,
  );

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(account_sanctions)
    .where(where);
  const rows = await db
    .select()
    .from(account_sanctions)
    .where(where)
    .orderBy(desc(account_sanctions.created_at), desc(account_sanctions.UniqueID))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const total = Number(countRow?.total ?? 0);
  return {
    items: rows.map((row) => serializeSanction(row, now)),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}

/** GET /api/sanctions/:id */
export async function getSanction(actor: Actor, rawId: unknown) {
  assertStaff(actor);
  return serializeSanction(await findSanction(parseSanctionId(rawId, 'id')));
}

/** POST /api/sanctions/:id/lift — retira una sanción vigente y deja el motivo. */
export async function liftSanction(actor: Actor, rawId: unknown, rawBody: unknown) {
  assertStaff(actor);
  const id = parseSanctionId(rawId, 'id');
  const input = parseLiftSanctionInput(rawBody);
  const sanction = await findSanction(id);
  const now = new Date();

  const status = sanctionStatus(sanction, now);
  if (status === 'retirada') {
    throw new ConflictError('La sanción ya fue retirada.', 'SANCTION_ALREADY_LIFTED');
  }
  if (status === 'vencida') {
    throw new ConflictError('La sanción ya venció.', 'SANCTION_EXPIRED');
  }

  // active = true en el filtro: si dos personas la retiran a la vez, solo una lo logra.
  const [updated] = await db
    .update(account_sanctions)
    .set({
      active: false,
      lifted_at: now,
      lifted_by: BigInt(actor.id),
      lift_reason: input.reason,
    })
    .where(and(eq(account_sanctions.UniqueID, id), eq(account_sanctions.active, true)))
    .returning();
  if (!updated) {
    throw new ConflictError('La sanción ya fue retirada.', 'SANCTION_ALREADY_LIFTED');
  }

  await eventBus.notify(
    new SanctionLiftedEvent({
      sanctionId: id.toString(),
      userId: updated.user_id.toString(),
      type: updated.type,
      liftedBy: actor.id,
      reason: input.reason,
    }),
  );

  return serializeSanction(updated, now);
}

/**
 * GET /api/sanctions/me — lo que la persona puede ver de su propia cuenta: restricciones y bajas de
 * reputación vigentes. Las marcas de usuario problemático son internas.
 */
export async function listMySanctions(actor: Actor) {
  const now = new Date();
  const rows = await db
    .select()
    .from(account_sanctions)
    .where(
      and(
        eq(account_sanctions.user_id, BigInt(actor.id)),
        inArray(account_sanctions.type, ['restriccion_temporal', 'baja_reputacion']),
        currentCondition(now),
      ),
    )
    .orderBy(desc(account_sanctions.created_at));

  return {
    items: rows.map((row) => ({
      id: row.UniqueID.toString(),
      type: row.type,
      reason: row.reason,
      starts_at: row.starts_at.toISOString(),
      ends_at: row.ends_at ? row.ends_at.toISOString() : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Restricción temporal: bloquea nuevas solicitudes
// ---------------------------------------------------------------------------

/**
 * Se llama al crear una solicitud (normal o de emergencia). Mientras haya una restricción temporal
 * vigente, el cliente no puede crear solicitudes nuevas; las que ya tenía siguen su curso.
 */
export async function assertClientNotRestricted(clientId: bigint): Promise<void> {
  const [restriction] = await db
    .select({ endsAt: account_sanctions.ends_at })
    .from(account_sanctions)
    .where(
      and(
        eq(account_sanctions.user_id, clientId),
        eq(account_sanctions.type, 'restriccion_temporal'),
        currentCondition(new Date()),
      ),
    )
    .orderBy(desc(account_sanctions.ends_at))
    .limit(1);

  if (restriction) {
    const until = restriction.endsAt ? ` hasta el ${formatSanctionDate(restriction.endsAt)}` : '';
    throw new ForbiddenError(
      `Tu cuenta tiene una restricción temporal y no puedes crear solicitudes nuevas${until}.`,
      'ACCOUNT_RESTRICTED',
    );
  }
}

// ---------------------------------------------------------------------------
// Alerta al proveedor
// ---------------------------------------------------------------------------

/**
 * Lo que ve el proveedor de un cliente antes de aceptar: si tiene marca vigente y cuántos reportes
 * tiene en su contra. Devuelve null cuando no hay nada que avisar. No expone los motivos internos.
 */
export async function getClientAlert(clientId: bigint) {
  const now = new Date();
  const [marks, [counts]] = await Promise.all([
    db
      .select({ type: account_sanctions.type, since: account_sanctions.starts_at })
      .from(account_sanctions)
      .where(
        and(
          eq(account_sanctions.user_id, clientId),
          inArray(account_sanctions.type, [...MARK_TYPES]),
          currentCondition(now),
        ),
      )
      .orderBy(desc(account_sanctions.starts_at)),
    db
      .select({
        confirmed: sql<number>`count(*) filter (where ${reports.status} = 'resuelto')::int`,
        inReview: sql<number>`count(*) filter (where ${reports.status} in ('pendiente', 'en_revision'))::int`,
      })
      .from(reports)
      .where(eq(reports.reported_id, clientId)),
  ]);

  const confirmed = Number(counts?.confirmed ?? 0);
  const inReview = Number(counts?.inReview ?? 0);
  const message = buildClientAlertMessage({
    marks: marks.length,
    confirmedReports: confirmed,
    reportsInReview: inReview,
  });
  if (!message) return null;

  return {
    has_mark: marks.length > 0,
    marks: marks.map((mark) => ({ type: mark.type, since: mark.since.toISOString() })),
    previous_reports: { confirmed, in_review: inReview },
    message,
  };
}

// ---------------------------------------------------------------------------
// Regla automática
// ---------------------------------------------------------------------------

/**
 * Se ejecuta cuando un reporte se resuelve (queda confirmado). Si la persona señalada acumula más
 * reportes confirmados que SANCTION_AUTO_MARK_THRESHOLD, se le pone la marca de usuario problemático.
 * - Solo cuenta lo confirmado después de la última marca automática que Soporte haya retirado.
 * - No repite la marca si ya tiene una automática vigente.
 * - Un candado por usuario evita marcas duplicadas si dos reportes se resuelven a la vez.
 */
export async function evaluateAutoMark(reportId: bigint, changedBy: bigint) {
  const [report] = await db
    .select({ reportedId: reports.reported_id })
    .from(reports)
    .where(eq(reports.UniqueID, reportId))
    .limit(1);
  if (!report?.reportedId) return null;
  const userId = report.reportedId;

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId.toString()}::bigint)`);
    const now = new Date();

    const [active] = await tx
      .select({ id: account_sanctions.UniqueID })
      .from(account_sanctions)
      .where(
        and(
          eq(account_sanctions.user_id, userId),
          eq(account_sanctions.type, 'usuario_problematico'),
          eq(account_sanctions.source, 'automatica'),
          currentCondition(now),
        ),
      )
      .limit(1);

    const [lastLift] = await tx
      .select({ liftedAt: sql<Date | null>`max(${account_sanctions.lifted_at})` })
      .from(account_sanctions)
      .where(
        and(
          eq(account_sanctions.user_id, userId),
          eq(account_sanctions.type, 'usuario_problematico'),
          eq(account_sanctions.source, 'automatica'),
        ),
      );
    const since = lastLift?.liftedAt ? new Date(lastLift.liftedAt) : null;

    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(reports)
      .where(
        and(
          eq(reports.reported_id, userId),
          eq(reports.status, 'resuelto'),
          since ? gt(reports.resolved_at, since) : undefined,
        ),
      );
    const confirmed = Number(counted?.total ?? 0);

    if (!shouldAutoMark(confirmed, ENV.SANCTION_AUTO_MARK_THRESHOLD, Boolean(active))) {
      return null;
    }

    const [row] = await tx
      .insert(account_sanctions)
      .values({
        user_id: userId,
        report_id: reportId,
        type: 'usuario_problematico',
        reason: autoMarkReason(confirmed),
        starts_at: now,
        ends_at: null,
        created_by: changedBy,
        source: 'automatica',
      })
      .returning();
    return row!;
  });

  if (!created) return null;

  await eventBus.notify(
    new SanctionAppliedEvent({
      sanctionId: created.UniqueID.toString(),
      userId: userId.toString(),
      type: 'usuario_problematico',
      reason: created.reason,
      endsAt: null,
      source: 'automatica',
      appliedBy: changedBy.toString(),
      reportId: reportId.toString(),
    }),
  );
  return created;
}
