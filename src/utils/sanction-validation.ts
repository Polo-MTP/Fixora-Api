import { BadRequestError } from '../errors/app-error.ts';

export const SANCTION_TYPES = [
  'restriccion_temporal',

  'baja_reputacion',

  'usuario_problematico',
] as const;

export type SanctionType = (typeof SANCTION_TYPES)[number];

export const SANCTION_STATUSES = ['vigente', 'vencida', 'retirada'] as const;

export type SanctionStatus = (typeof SANCTION_STATUSES)[number];

/** Marcas: no bloquean nada, sirven para alertar a los proveedores. */

export const MARK_TYPES: readonly SanctionType[] = ['baja_reputacion', 'usuario_problematico'];

export const SANCTION_MIN_REASON = 5;

export const SANCTION_MAX_REASON = 1000;

export const SANCTION_MAX_RESTRICTION_DAYS = 365;

export const SANCTION_DEFAULT_PAGE_SIZE = 20;

export const SANCTION_MAX_PAGE_SIZE = 100;

/** Por defecto, una cuenta se marca al superar 2 reportes confirmados (al tercero). */

export const DEFAULT_AUTO_MARK_THRESHOLD = 2;

const ID_PATTERN = /^[1-9]\d{0,17}$/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApplySanctionInput {
  user_id: bigint;

  type: SanctionType;

  reason: string;

  ends_at: Date | null;

  report_id: bigint | null;
}

export interface SanctionListQuery {
  page: number;

  limit: number;

  user_id: bigint | null;

  type: SanctionType | null;

  status: SanctionStatus | null;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }

  return value as Record<string, unknown>;
}

function noExtraKeys(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));

  if (extra.length) {
    throw new BadRequestError(`Campos no permitidos: ${extra.join(', ')}.`, 'VALIDATION_ERROR');
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestError(
      `${field} debe ser uno de: ${allowed.join(', ')}.`,

      'VALIDATION_ERROR',
    );
  }

  return value as T;
}

function reason(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestError(`${field} es obligatorio.`, 'VALIDATION_ERROR');
  }

  const trimmed = value.trim();

  if (trimmed.length < SANCTION_MIN_REASON || trimmed.length > SANCTION_MAX_REASON) {
    throw new BadRequestError(
      `${field} debe tener entre ${SANCTION_MIN_REASON} y ${SANCTION_MAX_REASON} caracteres.`,

      'VALIDATION_ERROR',
    );
  }

  return trimmed;
}

export function parseSanctionId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new BadRequestError(`${field} debe ser un identificador válido.`, 'VALIDATION_ERROR');
  }

  return BigInt(value);
}

/**

 * Valida el cuerpo de POST /api/sanctions.

 * - La restricción temporal exige `ends_at` (futuro y de máximo 365 días).

 * - Las marcas pueden no vencer; si traen `ends_at`, debe ser futuro.

 */

export function parseApplySanctionInput(raw: unknown, now: Date = new Date()): ApplySanctionInput {
  const body = plainObject(raw);

  noExtraKeys(body, ['user_id', 'type', 'reason', 'ends_at', 'report_id']);

  const type = oneOf(body.type, SANCTION_TYPES, 'type');

  let endsAt: Date | null = null;

  if (body.ends_at !== undefined && body.ends_at !== null) {
    if (typeof body.ends_at !== 'string' || !DATE_PATTERN.test(body.ends_at)) {
      throw new BadRequestError(
        'ends_at debe ser una fecha válida (por ejemplo 2026-12-31T23:59:00Z).',

        'VALIDATION_ERROR',
      );
    }

    endsAt = new Date(body.ends_at);

    if (Number.isNaN(endsAt.getTime())) {
      throw new BadRequestError('ends_at debe ser una fecha válida.', 'VALIDATION_ERROR');
    }

    if (endsAt.getTime() <= now.getTime()) {
      throw new BadRequestError('ends_at debe ser una fecha futura.', 'VALIDATION_ERROR');
    }
  }

  if (type === 'restriccion_temporal') {
    if (!endsAt) {
      throw new BadRequestError(
        'La restricción temporal necesita ends_at: es temporal.',

        'VALIDATION_ERROR',
      );
    }

    if (endsAt.getTime() - now.getTime() > SANCTION_MAX_RESTRICTION_DAYS * DAY_MS) {
      throw new BadRequestError(
        `La restricción temporal no puede durar más de ${SANCTION_MAX_RESTRICTION_DAYS} días.`,

        'VALIDATION_ERROR',
      );
    }
  }

  return {
    user_id: parseSanctionId(body.user_id, 'user_id'),

    type,

    reason: reason(body.reason, 'reason'),

    ends_at: endsAt,

    report_id:
      body.report_id === undefined || body.report_id === null
        ? null
        : parseSanctionId(body.report_id, 'report_id'),
  };
}

/** Valida el cuerpo de POST /api/sanctions/:id/lift. */

export function parseLiftSanctionInput(raw: unknown): { reason: string } {
  const body = plainObject(raw);

  noExtraKeys(body, ['reason']);

  return { reason: reason(body.reason, 'reason') };
}

/** Valida los filtros de GET /api/sanctions. */

export function parseSanctionListQuery(query: Record<string, unknown>): SanctionListQuery {
  let page = 1;

  if (query.page !== undefined) {
    const parsed = typeof query.page === 'string' ? Number(query.page) : NaN;

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }

    page = parsed;
  }

  let limit = SANCTION_DEFAULT_PAGE_SIZE;

  if (query.limit !== undefined) {
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SANCTION_MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `limit debe ser un entero entre 1 y ${SANCTION_MAX_PAGE_SIZE}.`,

        'VALIDATION_ERROR',
      );
    }

    limit = parsed;
  }

  return {
    page,

    limit,

    user_id: query.user_id === undefined ? null : parseSanctionId(query.user_id, 'user_id'),

    type: query.type === undefined ? null : oneOf(query.type, SANCTION_TYPES, 'type'),

    status: query.status === undefined ? null : oneOf(query.status, SANCTION_STATUSES, 'status'),
  };
}

// ---------------------------------------------------------------------------

// Vigencia y reglas

// ---------------------------------------------------------------------------

export interface SanctionWindow {
  active: boolean;

  starts_at: Date;

  ends_at: Date | null;
}

/** Retirada (se levantó a mano), vencida (llegó su fecha) o vigente. */

export function sanctionStatus(sanction: SanctionWindow, now: Date = new Date()): SanctionStatus {
  if (!sanction.active) return 'retirada';

  if (sanction.ends_at && sanction.ends_at.getTime() <= now.getTime()) return 'vencida';

  return 'vigente';
}

/** Vigente: activa, ya empezó y no ha vencido. */

export function isSanctionCurrent(sanction: SanctionWindow, now: Date = new Date()): boolean {
  return (
    sanction.starts_at.getTime() <= now.getTime() && sanctionStatus(sanction, now) === 'vigente'
  );
}

/**

 * Regla automática: se marca a quien acumula MÁS reportes confirmados que el umbral, y solo si no

 * tiene ya una marca automática vigente.

 */

export function shouldAutoMark(
  confirmedReports: number,

  threshold: number,

  hasActiveAutoMark: boolean,
): boolean {
  return !hasActiveAutoMark && confirmedReports > threshold;
}

export function autoMarkReason(confirmedReports: number): string {
  return `Marca automática: ${confirmedReports} reportes confirmados.`;
}

/** Las marcas de usuario problemático son internas: no se avisa a la persona marcada. */

export function notifiesUser(type: SanctionType): boolean {
  return type !== 'usuario_problematico';
}

/** Fecha legible para los avisos al usuario, en hora de la Ciudad de México. */

export function formatSanctionDate(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',

    timeStyle: 'short',

    timeZone: 'America/Mexico_City',
  }).format(date);
}

export interface ClientAlertInput {
  marks: number;

  confirmedReports: number;

  reportsInReview: number;
}

/** Texto de la alerta que ve el proveedor; null cuando no hay nada que avisar. */

export function buildClientAlertMessage(input: ClientAlertInput): string | null {
  const parts: string[] = [];

  if (input.marks > 0) parts.push('tiene una marca de usuario con antecedentes');

  if (input.confirmedReports > 0) {
    parts.push(
      `${input.confirmedReports} ${input.confirmedReports === 1 ? 'reporte confirmado' : 'reportes confirmados'}`,
    );
  }

  if (input.reportsInReview > 0) {
    parts.push(
      `${input.reportsInReview} ${input.reportsInReview === 1 ? 'reporte en revisión' : 'reportes en revisión'}`,
    );
  }

  if (!parts.length) return null;

  return `Este cliente ${input.marks > 0 ? '' : 'tiene '}${parts.join(', ')}.`.replace('  ', ' ');
}
