import { AppError, BadRequestError } from '../errors/app-error.ts';
import { addDays, localDateTimeToUtc, utcToLocal } from '../utils/timezone.ts';

/**
 * API-45: reglas de la agenda del proveedor, sin base de datos para poder probarlas solas.
 * Una cita es una solicitud con fecha (scheduled_at); un bloqueo es un rato en que el técnico no
 * atiende (schedule_blocks). Los dos ocupan tiempo y no se pueden encimar.
 */

/** Las que se ven en la agenda: las pendientes de responder, las activas y las terminadas. */
export const AGENDA_STATUSES = [
  'pendiente',
  'aceptada',
  'agendada',
  'en_curso',
  'en_camino',
  'llegado',
  'completada',
] as const;

/** Las que ocupan el horario: un bloqueo no puede caer encima de ellas. */
export const BUSY_STATUSES = [
  'pendiente',
  'aceptada',
  'agendada',
  'en_curso',
  'en_camino',
  'llegado',
] as const;

export const BLOCK_REASONS = ['vacaciones', 'personal', 'ocupado'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const MAX_AGENDA_DAYS = 31;
export const MAX_BLOCK_DAYS = 60;
export const DEFAULT_APPOINTMENT_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface AgendaAppointment extends TimeRange {
  id: string;
  status: string;
  employeeId: string;
  categoryName: string;
  clientName: string;
  zone: string;
}

export interface AgendaBlock extends TimeRange {
  id: string;
  employeeId: string;
  reason: string;
}

export interface BranchHours {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && a.end.getTime() > b.start.getTime();
}

/** Las de antes se guardaban sin fin: duran lo que dura su categoría. */
export function appointmentEnd(
  start: Date,
  scheduledEnd: Date | null,
  durationMinutes: number | null | undefined,
): Date {
  if (scheduledEnd) return scheduledEnd;
  const minutes =
    durationMinutes && durationMinutes > 0 ? durationMinutes : DEFAULT_APPOINTMENT_MINUTES;
  return new Date(start.getTime() + minutes * 60_000);
}

/** `en_curso` es el nombre anterior de `en_camino`. */
export function publicAgendaStatus(status: string): string {
  return status === 'en_curso' ? 'en_camino' : status;
}

/** Fecha AAAA-MM-DD; sin ella, hoy en la zona de la sucursal. */
export function parseAgendaFrom(value: unknown, timeZone: string, now = new Date()): string {
  if (value === undefined || value === '') return utcToLocal(now, timeZone).date;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError('from debe tener el formato AAAA-MM-DD.', 'VALIDATION_ERROR');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestError('from no es una fecha válida.', 'VALIDATION_ERROR');
  }
  return value;
}

/** 1 para el día y 7 para la semana; hasta [MAX_AGENDA_DAYS]. */
export function parseAgendaDays(value: unknown): number {
  if (value === undefined || value === '') return 1;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_AGENDA_DAYS) {
    throw new BadRequestError(
      `days debe ser un entero de 1 a ${MAX_AGENDA_DAYS}.`,
      'VALIDATION_ERROR',
    );
  }
  return days;
}

/** El rango en UTC que cubren [days] días locales desde [from]. */
export function agendaRange(from: string, days: number, timeZone: string): TimeRange {
  return {
    start: localDateTimeToUtc(from, '00:00', timeZone),
    end: localDateTimeToUtc(addDays(from, days), '00:00', timeZone),
  };
}

/** Día de la semana de una fecha AAAA-MM-DD (0 = domingo), como day_of_week de los horarios. */
export function dayOfWeekOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

/**
 * Reparte las citas y los bloqueos por día local. Una cita cuenta el día en que empieza; un
 * bloqueo aparece en cada día que toca (unas vacaciones salen en toda la semana).
 */
export function groupAgendaByDay(
  from: string,
  days: number,
  timeZone: string,
  hours: BranchHours[],
  appointments: AgendaAppointment[],
  blocks: AgendaBlock[],
) {
  const sortedAppointments = [...appointments].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const sortedBlocks = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(from, index);
    const dayRange = agendaRange(date, 1, timeZone);
    const dayOfWeek = dayOfWeekOf(date);
    return {
      date,
      day_of_week: dayOfWeek,
      hours: hours
        .filter((item) => item.dayOfWeek === dayOfWeek)
        .sort((a, b) => a.openTime.localeCompare(b.openTime))
        .map((item) => ({
          open_time: item.openTime.slice(0, 5),
          close_time: item.closeTime.slice(0, 5),
        })),
      appointments: sortedAppointments
        .filter((item) => utcToLocal(item.start, timeZone).date === date)
        .map((item) => ({
          request_id: item.id,
          status: publicAgendaStatus(item.status),
          needs_response: item.status === 'pendiente',
          starts_at: item.start.toISOString(),
          ends_at: item.end.toISOString(),
          employee_id: item.employeeId,
          category: item.categoryName,
          client_name: item.clientName,
          zone: item.zone,
        })),
      blocks: sortedBlocks
        .filter((item) => overlaps(item, dayRange))
        .map((item) => ({
          id: item.id,
          employee_id: item.employeeId,
          starts_at: item.start.toISOString(),
          ends_at: item.end.toISOString(),
          reason: item.reason,
        })),
    };
  });
}

export interface BlockInput {
  start?: Date;
  end?: Date;
  reason?: BlockReason;
  employeeId?: bigint;
}

function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError(`${field} debe ser una fecha y hora ISO 8601.`, 'VALIDATION_ERROR');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${field} no es una fecha y hora válida.`, 'VALIDATION_ERROR');
  }
  return date;
}

/** Cuerpo de crear (todo obligatorio menos employee_id) o editar (lo que venga). */
export function parseBlockInput(raw: unknown, partial: boolean): BlockInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = raw as Record<string, unknown>;
  const allowed = partial
    ? ['starts_at', 'ends_at', 'reason']
    : ['employee_id', 'starts_at', 'ends_at', 'reason'];
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw new BadRequestError(`Campos no permitidos: ${extra.join(', ')}.`, 'VALIDATION_ERROR');
  }
  if (partial && Object.keys(body).length === 0) {
    throw new BadRequestError('Envía al menos starts_at, ends_at o reason.', 'VALIDATION_ERROR');
  }

  const input: BlockInput = {};
  if (body.starts_at !== undefined || !partial)
    input.start = parseInstant(body.starts_at, 'starts_at');
  if (body.ends_at !== undefined || !partial) input.end = parseInstant(body.ends_at, 'ends_at');
  if (body.reason !== undefined || !partial) {
    if (typeof body.reason !== 'string' || !BLOCK_REASONS.includes(body.reason as BlockReason)) {
      throw new BadRequestError(
        `reason debe ser uno de: ${BLOCK_REASONS.join(', ')}.`,
        'VALIDATION_ERROR',
      );
    }
    input.reason = body.reason as BlockReason;
  }
  if (body.employee_id !== undefined) {
    if (typeof body.employee_id !== 'string' || !/^[1-9]\d{0,17}$/.test(body.employee_id)) {
      throw new BadRequestError('employee_id no es un identificador válido.', 'VALIDATION_ERROR');
    }
    input.employeeId = BigInt(body.employee_id);
  }
  return input;
}

/** Que termine después de empezar, que no haya terminado ya y que no dure más de [MAX_BLOCK_DAYS]. */
export function validateBlockWindow(range: TimeRange, now = new Date()): void {
  if (range.end.getTime() <= range.start.getTime()) {
    throw new BadRequestError('ends_at debe ser posterior a starts_at.', 'VALIDATION_ERROR');
  }
  if (range.end.getTime() <= now.getTime()) {
    throw new BadRequestError(
      'El bloqueo ya terminó: elige un horario que no haya pasado.',
      'VALIDATION_ERROR',
    );
  }
  if (range.end.getTime() - range.start.getTime() > MAX_BLOCK_DAYS * DAY_MS) {
    throw new BadRequestError(
      `Un bloqueo dura como máximo ${MAX_BLOCK_DAYS} días.`,
      'VALIDATION_ERROR',
    );
  }
}

/**
 * Un bloqueo no se puede encimar con otro bloqueo ni con una cita que ocupe el horario. Con
 * citas se responde la lista, para que el técnico las rechace o las atienda primero.
 */
export function assertBlockFits(
  range: TimeRange,
  otherBlocks: TimeRange[],
  busyAppointments: Array<TimeRange & { id: string; status: string }>,
): void {
  if (otherBlocks.some((block) => overlaps(block, range))) {
    throw new AppError('Ya tienes un bloqueo en ese horario.', 409, 'BLOCK_OVERLAP');
  }
  const conflicts = busyAppointments.filter((item) => overlaps(item, range));
  if (conflicts.length) {
    const error = new AppError(
      'Tienes citas en ese horario. Recházalas o atiéndelas antes de bloquearlo.',
      409,
      'SCHEDULE_CONFLICT',
    ) as AppError & { details?: unknown };
    error.details = conflicts.map((item) => ({
      request_id: item.id,
      status: publicAgendaStatus(item.status),
      starts_at: item.start.toISOString(),
      ends_at: item.end.toISOString(),
    }));
    throw error;
  }
}
