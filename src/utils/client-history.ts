import { BadRequestError } from '../errors/app-error.ts';

/** Estados que ve la app (los mismos de GET /api/service-requests). */
export const HISTORY_STATUSES = [
  'pendiente',
  'aceptada',
  'agendada',
  'en_camino',
  'llegado',
  'completada',
  'cancelada',
  'expirada',
] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

/** Estados en los que un servicio se considera "en curso" para el banner de la pantalla principal. */
export const ACTIVE_DB_STATUSES = [
  'pendiente',
  'aceptada',
  'en_camino',
  'en_curso',
  'llegado',
] as const;

export const HISTORY_DEFAULT_PAGE_SIZE = 20;
export const HISTORY_MAX_PAGE_SIZE = 100;

export interface HistoryQuery {
  page: number;
  limit: number;
  /** Estados públicos pedidos; null = todos. */
  status: HistoryStatus[] | null;
}

/** Valida los filtros de GET /api/me/services. `status` admite varios separados por coma. */
export function parseHistoryQuery(query: Record<string, unknown>): HistoryQuery {
  let page = 1;
  if (query.page !== undefined) {
    const parsed = typeof query.page === 'string' ? Number(query.page) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }
    page = parsed;
  }

  let limit = HISTORY_DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `limit debe ser un entero entre 1 y ${HISTORY_MAX_PAGE_SIZE}.`,
        'VALIDATION_ERROR',
      );
    }
    limit = parsed;
  }

  let status: HistoryStatus[] | null = null;
  if (query.status !== undefined && query.status !== '') {
    if (typeof query.status !== 'string') {
      throw new BadRequestError('status debe ser texto.', 'VALIDATION_ERROR');
    }
    const parts = [...new Set(query.status.split(',').map((part) => part.trim()))];
    for (const part of parts) {
      if (!(HISTORY_STATUSES as readonly string[]).includes(part)) {
        throw new BadRequestError(
          `El estado debe ser uno de: ${HISTORY_STATUSES.join(', ')}.`,
          'VALIDATION_ERROR',
        );
      }
    }
    status = parts as HistoryStatus[];
  }

  return { page, limit, status };
}

/** Estados de la base de datos que corresponden a los estados públicos pedidos. */
export function dbStatusesFor(statuses: readonly HistoryStatus[]): string[] {
  // Registros antiguos usan en_curso para lo que hoy es en_camino.
  return statuses.flatMap((status) =>
    status === 'en_camino' ? ['en_camino', 'en_curso'] : [status],
  );
}

/** Estado que ve la app: en_curso (anterior a separar En camino y Llegado) se muestra como en_camino. */
export function publicStatus(status: string): string {
  return status === 'en_curso' ? 'en_camino' : status;
}

/** Etapa del servicio, para que la pantalla principal elija el texto y el color del banner. */
export function servicePhase(status: string): string {
  switch (status) {
    case 'pendiente':
      return 'buscando_tecnico';
    case 'aceptada':
      return 'tecnico_asignado';
    case 'en_camino':
    case 'en_curso':
      return 'tecnico_en_camino';
    case 'llegado':
      return 'tecnico_en_el_lugar';
    case 'agendada':
      return 'agendado';
    case 'completada':
      return 'finalizado';
    case 'cancelada':
      return 'cancelado';
    case 'expirada':
      return 'expirado';
    default:
      return status;
  }
}

/** Cuanto más cerca está de terminar, más importante es para el banner. */
const ACTIVE_PRIORITY: Record<string, number> = {
  llegado: 0,
  en_camino: 1,
  en_curso: 1,
  aceptada: 2,
  pendiente: 3,
};

export function isActiveStatus(status: string): boolean {
  return status in ACTIVE_PRIORITY;
}

/** Elige el servicio que muestra el banner: el más avanzado y, a igual avance, el más reciente. */
export function pickActiveService<T extends { status: string; created_at: Date }>(
  rows: readonly T[],
): T | null {
  const active = rows.filter((row) => isActiveStatus(row.status));
  if (!active.length) return null;
  return [...active].sort((a, b) => {
    const byPhase = ACTIVE_PRIORITY[a.status]! - ACTIVE_PRIORITY[b.status]!;
    return byPhase !== 0 ? byPhase : b.created_at.getTime() - a.created_at.getTime();
  })[0]!;
}

/** El seguimiento en el mapa tiene sentido mientras el técnico va en camino o ya llegó. */
export function canTrack(status: string): boolean {
  return status === 'en_camino' || status === 'en_curso' || status === 'llegado';
}

/** El chat existe desde que un técnico acepta y hasta que el servicio termina. */
export function canChat(status: string, hasTechnician: boolean): boolean {
  return (
    hasTechnician && ['aceptada', 'agendada', 'en_camino', 'en_curso', 'llegado'].includes(status)
  );
}

export interface PaymentFigures {
  total: string | null;
  paid: string;
  pending_confirmation: string;
}

const toCents = (value: string | null): number => {
  if (!value) return 0;
  const [whole, decimals = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0').slice(0, 2));
};

/**
 * Estado del pago para la lista:
 * - `no_aplica`: se canceló o expiró, no hay nada que cobrar.
 * - `pagado`: lo confirmado cubre el total.
 * - `parcial`: hay pagos confirmados pero falta saldo.
 * - `por_confirmar`: el cliente registró un pago y el proveedor aún no lo confirma.
 * - `sin_pago`: todavía no hay pagos.
 */
export function paymentStatus(serviceStatus: string, figures: PaymentFigures): string {
  if (serviceStatus === 'cancelada' || serviceStatus === 'expirada') return 'no_aplica';
  const total = toCents(figures.total);
  const paid = toCents(figures.paid);
  if (total > 0 && paid >= total) return 'pagado';
  if (paid > 0) return 'parcial';
  if (toCents(figures.pending_confirmation) > 0) return 'por_confirmar';
  return 'sin_pago';
}

/**
 * Costo que se muestra:
 * - finalizada: el total que se fijó al terminar;
 * - en curso o pendiente: el estimado (precio acordado más ajustes aprobados);
 * - cancelada o expirada: nada, porque no se cobra.
 */
export function visibleCost(
  status: string,
  total: string | null,
  estimate: string | null,
): string | null {
  if (status === 'cancelada' || status === 'expirada') return null;
  return status === 'completada' ? (total ?? estimate) : estimate;
}
