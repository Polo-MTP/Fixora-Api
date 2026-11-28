import { BadRequestError } from '../errors/app-error.ts';
import { calculateHaversineDistanceKm } from './geo.utils.ts';
import {
  REPORT_CATEGORIES,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  REPORT_TYPES,
  parseReportId,
  type ReportCategory,
  type ReportPriority,
  type ReportStatus,
  type ReportType,
} from './report-validation.ts';

export const INBOX_SORTS = ['prioridad', 'antiguedad', 'actividad'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const TIMELINE_TYPES = [
  'estado',
  'despacho',
  'cancelacion',
  'chat',
  'pago',
  'ajuste_precio',
  'evidencia',
  'reporte',
] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

/** Horas sin resolverse a partir de las cuales un reporte abierto se marca como atrasado. */
export const INBOX_OVERDUE_HOURS = 48;
export const INBOX_DEFAULT_PAGE_SIZE = 20;
export const INBOX_MAX_PAGE_SIZE = 100;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InboxQuery {
  page: number;
  limit: number;
  status: ReportStatus[] | null;
  type: ReportType | null;
  category: ReportCategory | null;
  priority: ReportPriority | null;
  request_id: bigint | null;
  /** 'me', 'unassigned' o el id de una persona de Soporte. */
  assigned: 'me' | 'unassigned' | bigint | null;
  /** Folio completo o parte inicial; si son solo dígitos, también busca por id de solicitud. */
  q: string | null;
  created_from: Date | null;
  /** Límite superior EXCLUSIVO: una fecha sin hora incluye todo ese día. */
  created_before: Date | null;
  sort: InboxSort;
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

function parseDate(value: unknown, field: string, endOfDay: boolean): Date {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new BadRequestError(
      `${field} debe ser una fecha válida (por ejemplo 2026-11-01).`,
      'VALIDATION_ERROR',
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${field} debe ser una fecha válida.`, 'VALIDATION_ERROR');
  }
  // "2026-11-30" como fecha final incluye todo el día 30.
  return endOfDay && DATE_ONLY_PATTERN.test(value) ? new Date(date.getTime() + DAY_MS) : date;
}

/** Valida los filtros de GET /api/support/inbox. */
export function parseInboxQuery(query: Record<string, unknown>): InboxQuery {
  let page = 1;
  if (query.page !== undefined) {
    const parsed = typeof query.page === 'string' ? Number(query.page) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }
    page = parsed;
  }

  let limit = INBOX_DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > INBOX_MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `limit debe ser un entero entre 1 y ${INBOX_MAX_PAGE_SIZE}.`,
        'VALIDATION_ERROR',
      );
    }
    limit = parsed;
  }

  let status: ReportStatus[] | null = null;
  if (query.status !== undefined) {
    if (typeof query.status !== 'string') {
      throw new BadRequestError('status debe ser texto.', 'VALIDATION_ERROR');
    }
    const parts = [...new Set(query.status.split(',').map((part) => part.trim()))];
    status = parts.map((part) => oneOf(part, REPORT_STATUSES, 'status'));
  }

  let assigned: InboxQuery['assigned'] = null;
  if (query.assigned !== undefined) {
    assigned =
      query.assigned === 'me' || query.assigned === 'unassigned'
        ? query.assigned
        : parseReportId(query.assigned, 'assigned');
  }

  let q: string | null = null;
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(query.q.trim())) {
      throw new BadRequestError('q debe ser un folio o un id de solicitud.', 'VALIDATION_ERROR');
    }
    q = query.q.trim().toUpperCase();
  }

  const createdFrom =
    query.created_from === undefined ? null : parseDate(query.created_from, 'created_from', false);
  const createdBefore =
    query.created_to === undefined ? null : parseDate(query.created_to, 'created_to', true);
  if (createdFrom && createdBefore && createdFrom.getTime() >= createdBefore.getTime()) {
    throw new BadRequestError('created_from debe ser anterior a created_to.', 'VALIDATION_ERROR');
  }

  const optional = <T extends string>(value: unknown, allowed: readonly T[], field: string) =>
    value === undefined ? null : oneOf(value, allowed, field);

  return {
    page,
    limit,
    status,
    type: optional(query.type, REPORT_TYPES, 'type'),
    category: optional(query.category, REPORT_CATEGORIES, 'category'),
    priority: optional(query.priority, REPORT_PRIORITIES, 'priority'),
    request_id:
      query.request_id === undefined ? null : parseReportId(query.request_id, 'request_id'),
    assigned,
    q,
    created_from: createdFrom,
    created_before: createdBefore,
    sort: query.sort === undefined ? 'prioridad' : oneOf(query.sort, INBOX_SORTS, 'sort'),
  };
}

/**
 * Valida el cuerpo de POST /api/support/inbox/:id/resolve y lo convierte al cuerpo del cambio de
 * estado. Solo admite resolution_type, comment y priority; la validación de fondo (tipo y
 * comentario obligatorios) la hace el cambio de estado.
 */
export function buildResolveBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter(
    (key) => !['resolution_type', 'comment', 'priority'].includes(key),
  );
  if (extra.length) {
    throw new BadRequestError(`Campos no permitidos: ${extra.join(', ')}.`, 'VALIDATION_ERROR');
  }
  return { ...body, status: 'resuelto' };
}

/** Valida ?types= de la línea de tiempo (lista separada por comas). Null = todos. */
export function parseTimelineQuery(query: Record<string, unknown>): {
  types: ReadonlySet<TimelineType> | null;
} {
  if (query.types === undefined) return { types: null };
  if (typeof query.types !== 'string') {
    throw new BadRequestError('types debe ser texto.', 'VALIDATION_ERROR');
  }
  const parts = query.types
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    throw new BadRequestError('types no puede estar vacío.', 'VALIDATION_ERROR');
  }
  return { types: new Set(parts.map((part) => oneOf(part, TIMELINE_TYPES, 'types'))) };
}

// ---------------------------------------------------------------------------
// Bandeja: antigüedad
// ---------------------------------------------------------------------------

export function reportAgeHours(createdAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (60 * 60 * 1000)));
}

/** Atrasado: sigue abierto y lleva más de INBOX_OVERDUE_HOURS sin resolverse. */
export function isOverdue(status: string, createdAt: Date, now: Date = new Date()): boolean {
  const open = status === 'pendiente' || status === 'en_revision';
  return open && reportAgeHours(createdAt, now) >= INBOX_OVERDUE_HOURS;
}

// ---------------------------------------------------------------------------
// Línea de tiempo del servicio
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  at: string;
  type: TimelineType;
  kind: string;
  title: string;
  actor: { id: string; name: string | null; role: string | null } | null;
  details: Record<string, unknown>;
  location: { latitude: number; longitude: number } | null;
}

/** Orden para desempatar entradas con la misma hora: primero lo que originó lo demás. */
const TYPE_ORDER: Record<TimelineType, number> = {
  estado: 0,
  despacho: 1,
  cancelacion: 2,
  evidencia: 3,
  ajuste_precio: 4,
  pago: 5,
  chat: 6,
  reporte: 7,
};

/** Ordena las entradas de la más antigua a la más reciente, de forma estable. */
export function mergeTimeline(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byTime = Date.parse(a.entry.at) - Date.parse(b.entry.at);
      if (byTime !== 0) return byTime;
      const byType = TYPE_ORDER[a.entry.type] - TYPE_ORDER[b.entry.type];
      return byType !== 0 ? byType : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export interface ServiceMoments {
  created_at: Date | null;
  accepted_at: Date | null;
  arrived_at: Date | null;
  completed_at: Date | null;
  canceled_at: Date | null;
}

function diffMinutes(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  return minutes < 0 ? null : minutes;
}

/** Tiempos del servicio en minutos; null cuando falta alguno de los dos momentos. */
export function computeServiceDurations(moments: ServiceMoments) {
  return {
    to_accept_minutes: diffMinutes(moments.created_at, moments.accepted_at),
    to_arrive_minutes: diffMinutes(moments.accepted_at, moments.arrived_at),
    service_minutes: diffMinutes(moments.arrived_at, moments.completed_at),
    total_minutes: diffMinutes(moments.created_at, moments.completed_at ?? moments.canceled_at),
  };
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Distancia en metros entre dos puntos; null si falta alguno. */
export function distanceMeters(a: GeoPoint | null, b: GeoPoint | null): number | null {
  if (!a || !b) return null;
  return Math.round(
    calculateHaversineDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude) * 1000,
  );
}

/** Convierte una coordenada numeric de la base de datos; null si falta o no es válida. */
export function toGeoPoint(
  latitude: string | number | null | undefined,
  longitude: string | number | null | undefined,
): GeoPoint | null {
  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return null;
  }
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : null;
}
