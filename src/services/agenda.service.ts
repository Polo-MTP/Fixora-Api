import { and, eq, gt, inArray, isNotNull, lt, ne } from 'drizzle-orm';

import { db } from '../config/database.ts';
import {
  addresses,
  branch_schedules,
  branches,
  branches_categories,
  categories,
  employees,
  personal_data,
  schedule_blocks,
  service_requests,
} from '../database/schema/tables.ts';
import { BadRequestError, NotFoundError } from '../errors/app-error.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import {
  AGENDA_STATUSES,
  BUSY_STATUSES,
  agendaRange,
  appointmentEnd,
  assertBlockFits,
  groupAgendaByDay,
  parseAgendaDays,
  parseAgendaFrom,
  parseBlockInput,
  validateBlockWindow,
  type AgendaAppointment,
  type TimeRange,
} from './agenda.rules.ts';
import { employeeProfileService } from './employee-profile.service.ts';
import { checkBranchAccess } from './portfolio.service.ts';
import { addDays } from '../utils/timezone.ts';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/**
 * API-45: agenda del proveedor. El técnico ve su agenda; el dueño o el gerente, la de su sucursal
 * o la de uno de sus técnicos. Los bloqueos (vacaciones, personal, ocupado) los pone el técnico o
 * quien administra la sucursal, y el cálculo de horarios libres ya los respeta al agendar.
 */

function parseId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new BadRequestError(`${field} no es un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

/** Los técnicos de la cuenta que atienden, del más antiguo al más nuevo. */
async function ownEmployees(actor: Actor) {
  return db
    .select({ id: employees.UniqueID, branchId: employees.branch_id })
    .from(employees)
    .where(and(eq(employees.user_id, BigInt(actor.id)), eq(employees.active, true)))
    .orderBy(employees.UniqueID);
}

/**
 * De quién es la agenda: un técnico ([employee_id]), toda una sucursal ([branch_id], solo dueño,
 * gerente o administrador) o, sin parámetros, la del propio técnico (o la sucursal del gerente).
 */
async function resolveScope(actor: Actor, query: { employee_id?: unknown; branch_id?: unknown }) {
  if (query.employee_id !== undefined) {
    const employeeId = parseId(query.employee_id, 'employee_id');
    const access = await employeeProfileService.checkEmployeeAccess(
      employeeId,
      actor as AuthenticatedUser,
    );
    return { branchId: access.branchId, employeeIds: [employeeId] };
  }

  let branchId: bigint;
  if (query.branch_id !== undefined) {
    branchId = parseId(query.branch_id, 'branch_id');
    await checkBranchAccess(branchId, actor as AuthenticatedUser);
  } else {
    const own = await ownEmployees(actor);
    if (!own.length) {
      throw new BadRequestError(
        'Tu cuenta no atiende servicios: indica branch_id para ver la agenda de una sucursal.',
        'AGENDA_SCOPE_REQUIRED',
      );
    }
    branchId = own[0]!.branchId;
    // El técnico ve solo lo suyo; el gerente, toda su sucursal.
    if (actor.role !== 'gerente') {
      return {
        branchId,
        employeeIds: own.filter((e) => e.branchId === branchId).map((e) => e.id),
      };
    }
  }

  const staff = await db
    .select({ id: employees.UniqueID })
    .from(employees)
    .where(
      and(
        eq(employees.branch_id, branchId),
        eq(employees.active, true),
        eq(employees.can_attend, true),
      ),
    );
  return { branchId, employeeIds: staff.map((e) => e.id) };
}

async function loadBranch(branchId: bigint) {
  const [branch] = await db
    .select({ id: branches.UniqueID, name: branches.name, timezone: branches.timezone })
    .from(branches)
    .where(eq(branches.UniqueID, branchId))
    .limit(1);
  if (!branch) throw new NotFoundError('Sucursal no encontrada.');
  return branch;
}

/** Citas de [employeeIds] que empiezan dentro de [range] (o un día antes, por si se alargan). */
async function loadAppointments(
  employeeIds: bigint[],
  range: TimeRange,
  statuses: readonly string[],
): Promise<AgendaAppointment[]> {
  if (!employeeIds.length) return [];
  const rows = await db
    .select({
      id: service_requests.UniqueID,
      status: service_requests.status,
      employeeId: service_requests.employee_id,
      start: service_requests.scheduled_at,
      scheduledEnd: service_requests.scheduled_end,
      clientName: service_requests.client_name,
      clientId: service_requests.client_id,
      category: categories.name,
      duration: branches_categories.duration_minutes,
      colony: addresses.colony,
    })
    .from(service_requests)
    .innerJoin(categories, eq(service_requests.category_id, categories.UniqueID))
    .leftJoin(
      branches_categories,
      and(
        eq(branches_categories.branch_id, service_requests.branch_id),
        eq(branches_categories.category_id, service_requests.category_id),
      ),
    )
    .leftJoin(addresses, eq(addresses.UniqueID, service_requests.address_id))
    .where(
      and(
        inArray(service_requests.employee_id, employeeIds),
        isNotNull(service_requests.scheduled_at),
        gt(service_requests.scheduled_at, new Date(range.start.getTime() - 24 * 60 * 60_000)),
        lt(service_requests.scheduled_at, range.end),
        inArray(service_requests.status, [...statuses] as (typeof AGENDA_STATUSES)[number][]),
      ),
    );

  // Nombre del cliente: el que quedó al aceptar (API-55) o, si aún no se acepta, el actual.
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

  return rows.map((row) => ({
    id: row.id.toString(),
    status: row.status,
    employeeId: row.employeeId!.toString(),
    start: row.start!,
    end: appointmentEnd(row.start!, row.scheduledEnd, row.duration),
    categoryName: row.category,
    clientName: row.clientName ?? nameById.get(row.clientId.toString()) ?? '',
    zone: row.colony ?? '',
  }));
}

async function loadBlocks(employeeIds: bigint[], range: TimeRange, excludeId?: bigint) {
  if (!employeeIds.length) return [];
  const rows = await db
    .select()
    .from(schedule_blocks)
    .where(
      and(
        inArray(schedule_blocks.employee_id, employeeIds),
        lt(schedule_blocks.starts_at, range.end),
        gt(schedule_blocks.ends_at, range.start),
        excludeId ? ne(schedule_blocks.UniqueID, excludeId) : undefined,
      ),
    );
  return rows.map((row) => ({
    id: row.UniqueID.toString(),
    employeeId: row.employee_id.toString(),
    start: row.starts_at,
    end: row.ends_at,
    reason: row.reason,
  }));
}

/** GET /api/agenda: citas y bloqueos de [days] días desde [from], con el horario de la sucursal. */
export async function getAgenda(
  actor: Actor,
  query: { from?: unknown; days?: unknown; employee_id?: unknown; branch_id?: unknown },
) {
  const scope = await resolveScope(actor, query);
  const branch = await loadBranch(scope.branchId);
  const from = parseAgendaFrom(query.from, branch.timezone);
  const days = parseAgendaDays(query.days);
  const range = agendaRange(from, days, branch.timezone);

  const hours = await db
    .select({
      dayOfWeek: branch_schedules.day_of_week,
      openTime: branch_schedules.open_time,
      closeTime: branch_schedules.close_time,
    })
    .from(branch_schedules)
    .where(and(eq(branch_schedules.branch_id, branch.id), eq(branch_schedules.active, true)));
  const appointments = await loadAppointments(scope.employeeIds, range, AGENDA_STATUSES);
  const blocks = await loadBlocks(scope.employeeIds, range);
  const staff = scope.employeeIds.length
    ? await db
        .select({
          id: employees.UniqueID,
          name: personal_data.name,
          last: personal_data.lastname_p,
        })
        .from(employees)
        .innerJoin(personal_data, eq(personal_data.user_id, employees.user_id))
        .where(inArray(employees.UniqueID, scope.employeeIds))
    : [];

  return {
    branch: { id: branch.id.toString(), name: branch.name, timezone: branch.timezone },
    from,
    to: addDays(from, days - 1),
    employees: staff.map((e) => ({ id: e.id.toString(), name: `${e.name} ${e.last}`.trim() })),
    days: groupAgendaByDay(from, days, branch.timezone, hours, appointments, blocks),
  };
}

function serializeBlock(row: typeof schedule_blocks.$inferSelect) {
  return {
    id: row.UniqueID.toString(),
    employee_id: row.employee_id.toString(),
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
    reason: row.reason,
    created_at: row.created_at.toISOString(),
  };
}

/** Revisa que [range] quepa en la agenda del técnico, sin contar el bloqueo [excludeId]. */
async function assertFits(employeeId: bigint, range: TimeRange, excludeId?: bigint) {
  const otherBlocks = await loadBlocks([employeeId], range, excludeId);
  const busy = await loadAppointments([employeeId], range, BUSY_STATUSES);
  assertBlockFits(range, otherBlocks, busy);
}

/** POST /api/agenda/blocks: sin employee_id, el bloqueo es del propio técnico. */
export async function createBlock(actor: Actor, raw: unknown) {
  const input = parseBlockInput(raw, false);
  let employeeId = input.employeeId;
  if (employeeId === undefined) {
    const own = await ownEmployees(actor);
    if (!own.length) {
      throw new BadRequestError(
        'Indica employee_id: tu cuenta no atiende servicios.',
        'VALIDATION_ERROR',
      );
    }
    employeeId = own[0]!.id;
  }
  await employeeProfileService.checkEmployeeAccess(employeeId, actor as AuthenticatedUser);

  const range = { start: input.start!, end: input.end! };
  validateBlockWindow(range);
  await assertFits(employeeId, range);

  const [created] = await db
    .insert(schedule_blocks)
    .values({
      employee_id: employeeId,
      starts_at: range.start,
      ends_at: range.end,
      reason: input.reason!,
    })
    .returning();
  return serializeBlock(created!);
}

async function findBlock(actor: Actor, rawId: unknown) {
  const id = parseId(rawId, 'El identificador del bloqueo');
  const [block] = await db
    .select()
    .from(schedule_blocks)
    .where(eq(schedule_blocks.UniqueID, id))
    .limit(1);
  if (!block) throw new NotFoundError('Bloqueo no encontrado.');
  await employeeProfileService.checkEmployeeAccess(block.employee_id, actor as AuthenticatedUser);
  return block;
}

/** PATCH /api/agenda/blocks/:id: cambia el horario o el motivo. */
export async function updateBlock(actor: Actor, rawId: unknown, raw: unknown) {
  const block = await findBlock(actor, rawId);
  const input = parseBlockInput(raw, true);
  const range = { start: input.start ?? block.starts_at, end: input.end ?? block.ends_at };
  validateBlockWindow(range);
  await assertFits(block.employee_id, range, block.UniqueID);

  const [updated] = await db
    .update(schedule_blocks)
    .set({ starts_at: range.start, ends_at: range.end, reason: input.reason ?? block.reason })
    .where(eq(schedule_blocks.UniqueID, block.UniqueID))
    .returning();
  return serializeBlock(updated!);
}

/** DELETE /api/agenda/blocks/:id: el horario vuelve a quedar libre para agendar. */
export async function deleteBlock(actor: Actor, rawId: unknown) {
  const block = await findBlock(actor, rawId);
  await db.delete(schedule_blocks).where(eq(schedule_blocks.UniqueID, block.UniqueID));
}
