import { BadRequestError } from '../errors/app-error.ts';
import { addDays, utcToLocal } from '../utils/timezone.ts';

/**
 * API-44: cálculos de las estadísticas del proveedor, sin base de datos para probarlos solos.
 *
 * Las aceptadas se cuentan por accepted_at de la solicitud, que siempre existe. Los rechazos y las
 * emergencias vencidas salen de request_dispatches (rechazo y expiro). En una emergencia el aviso
 * llega en notified_at; en una solicitud normal el registro se crea al responder, así que el
 * tiempo se mide desde que el cliente la creó.
 */

export const DEFAULT_PERIOD_DAYS = 30;
export const MAX_PERIOD_DAYS = 366;

export interface StatsPeriod {
  from: string;
  to: string;
}

function parseDay(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError(`${field} debe tener el formato AAAA-MM-DD.`, 'VALIDATION_ERROR');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestError(`${field} no es una fecha válida.`, 'VALIDATION_ERROR');
  }
  return value;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Del día [from] al día [to], los dos incluidos. Sin fechas, los últimos 30 días hasta hoy en la
 * zona de la sucursal; con solo una, se completa la otra a 30 días.
 */
export function parseStatsPeriod(
  query: { from?: unknown; to?: unknown },
  timeZone: string,
  now = new Date(),
): StatsPeriod {
  const today = utcToLocal(now, timeZone).date;
  const hasFrom = query.from !== undefined && query.from !== '';
  const hasTo = query.to !== undefined && query.to !== '';
  const to = hasTo
    ? parseDay(query.to, 'to')
    : hasFrom
      ? addDays(parseDay(query.from, 'from'), DEFAULT_PERIOD_DAYS - 1)
      : today;
  const from = hasFrom ? parseDay(query.from, 'from') : addDays(to, -(DEFAULT_PERIOD_DAYS - 1));
  if (daysBetween(from, to) < 0) {
    throw new BadRequestError('to no puede ser anterior a from.', 'VALIDATION_ERROR');
  }
  if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) {
    throw new BadRequestError(
      `El periodo puede ser de hasta ${MAX_PERIOD_DAYS} días.`,
      'VALIDATION_ERROR',
    );
  }
  return { from, to };
}

export interface DispatchResponse {
  response: string;
  isEmergency: boolean;
  requestCreatedAt: Date;
  notifiedAt: Date;
  respondedAt: Date | null;
}

/** Segundos que tardó en responder, o null si no respondió (vencida o sin fecha). */
export function responseSeconds(row: DispatchResponse): number | null {
  if (row.response !== 'acepto' && row.response !== 'rechazo') return null;
  if (!row.respondedAt) return null;
  const since = row.isEmergency ? row.notifiedAt : row.requestCreatedAt;
  const seconds = Math.round((row.respondedAt.getTime() - since.getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
}

export function averageSeconds(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

/**
 * Porcentaje de las solicitudes que le llegaron y aceptó. Las que dejó vencer cuentan como no
 * aceptadas; las que tomó otro técnico (retirado) no cuentan. null si no le llegó ninguna.
 */
export function acceptanceRate(accepted: number, rejected: number, expired: number): number | null {
  const total = accepted + rejected + expired;
  if (total === 0) return null;
  return Math.round((accepted / total) * 1000) / 10;
}

/** Promedio con un decimal, o null sin reseñas. */
export function roundRating(
  average: string | number | null | undefined,
  count: number,
): number | null {
  if (!count || average === null || average === undefined) return null;
  const value = Number(average);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** Cuenta los rechazos y las emergencias vencidas; las aceptadas se cuentan por accepted_at. */
export function countResponses(rows: DispatchResponse[]) {
  return {
    rejected: rows.filter((row) => row.response === 'rechazo').length,
    expired: rows.filter((row) => row.response === 'expiro').length,
  };
}

export interface AcceptedRequest {
  isEmergency: boolean;
  createdAt: Date;
  acceptedAt: Date;
  /** Cuándo le llegó el aviso de la emergencia al técnico que la tomó, si quedó registrado. */
  notifiedAt: Date | null;
}

/** Segundos desde que le llegó hasta que la aceptó. */
export function acceptedResponseSeconds(row: AcceptedRequest): number | null {
  const since = row.isEmergency && row.notifiedAt ? row.notifiedAt : row.createdAt;
  const seconds = Math.round((row.acceptedAt.getTime() - since.getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
}
