import { BadRequestError } from '../errors/app-error.ts';

export const REPORT_TYPES = ['reporte', 'garantia', 'reclamacion'] as const;
export const REPORT_CATEGORIES = [
  'servicio_incompleto',
  'cobro_indebido',
  'danos',
  'conducta_inapropiada',
  'otro',
] as const;
export const REPORT_PRIORITIES = ['baja', 'media', 'alta', 'urgente'] as const;
export const REPORT_STATUSES = ['pendiente', 'en_revision', 'resuelto', 'rechazado'] as const;
export const REPORT_RESOLUTION_TYPES = [
  'sin_sancion',
  'reembolso',
  'sancion_usuario',
  'bloqueo_cuenta',
  'otro',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportResolutionType = (typeof REPORT_RESOLUTION_TYPES)[number];

export const REPORT_MIN_DESCRIPTION = 10;
export const REPORT_MAX_TEXT = 2000;
/** Evidencias por envío, y total por reporte. */
export const REPORT_MAX_EVIDENCE_PER_REQUEST = 5;
export const REPORT_MAX_EVIDENCE_TOTAL = 10;
export const REPORT_DEFAULT_PAGE_SIZE = 20;
export const REPORT_MAX_PAGE_SIZE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[1-9]\d{0,17}$/;

const FOLIO_PREFIX: Record<ReportType, string> = {
  reporte: 'REP',
  garantia: 'GAR',
  reclamacion: 'REC',
};

/** Estados a los que puede pasar un reporte. Resuelto y rechazado son finales. */
const REPORT_TRANSITIONS: Readonly<Record<ReportStatus, readonly ReportStatus[]>> = {
  pendiente: ['en_revision', 'rechazado'],
  en_revision: ['resuelto', 'rechazado'],
  resuelto: [],
  rechazado: [],
};

export function isValidReportTransition(from: ReportStatus, to: ReportStatus): boolean {
  return REPORT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isReportClosed(status: string): boolean {
  return status === 'resuelto' || status === 'rechazado';
}

/** Soporte y Administrador atienden los reportes; el resto solo ve y comenta los suyos. */
export function isStaffRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === 'soporte' || normalized === 'administrador';
}

/** REP-2026-000123 para reportes, GAR- para garantías y REC- para reclamaciones. */
export function formatFolio(type: ReportType, year: number, sequence: string | number): string {
  return `${FOLIO_PREFIX[type]}-${year}-${String(sequence).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Utilidades de validación
// ---------------------------------------------------------------------------

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

function text(value: unknown, field: string, min: number): string {
  if (typeof value !== 'string') {
    throw new BadRequestError(`${field} debe ser texto.`, 'VALIDATION_ERROR');
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new BadRequestError(
      min <= 1 ? `${field} es obligatorio.` : `${field} debe tener al menos ${min} caracteres.`,
      'VALIDATION_ERROR',
    );
  }
  if (trimmed.length > REPORT_MAX_TEXT) {
    throw new BadRequestError(
      `${field} no debe exceder ${REPORT_MAX_TEXT} caracteres.`,
      'VALIDATION_ERROR',
    );
  }
  return trimmed;
}

function evidenceKeys(value: unknown, max: number, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) {
      throw new BadRequestError('attachment_keys es obligatorio.', 'VALIDATION_ERROR');
    }
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > max ||
    (required && value.length === 0) ||
    value.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)
  ) {
    throw new BadRequestError(
      `attachment_keys debe contener ${required ? 'de 1' : 'hasta'} ${max} llaves de archivos válidas.`,
      'VALIDATION_ERROR',
    );
  }
  const keys = value as string[];
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestError('No repitas llaves en attachment_keys.', 'VALIDATION_ERROR');
  }
  return keys;
}

export function parseReportId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new BadRequestError(`${field} debe ser un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Entradas de cada operación
// ---------------------------------------------------------------------------

export interface CreateReportInput {
  request_id: bigint;
  type: ReportType;
  category: ReportCategory;
  description: string;
  attachment_keys: string[];
  client_uuid: string | null;
}

/** POST /api/reports */
export function parseCreateReportInput(raw: unknown): CreateReportInput {
  const body = plainObject(raw);
  noExtraKeys(body, [
    'request_id',
    'type',
    'category',
    'description',
    'attachment_keys',
    'client_uuid',
  ]);

  let clientUuid: string | null = null;
  if (body.client_uuid !== undefined && body.client_uuid !== null) {
    if (typeof body.client_uuid !== 'string' || !UUID_PATTERN.test(body.client_uuid)) {
      throw new BadRequestError('client_uuid debe ser un UUID válido.', 'VALIDATION_ERROR');
    }
    clientUuid = body.client_uuid.toLowerCase();
  }

  return {
    request_id: parseReportId(body.request_id, 'request_id'),
    type: body.type === undefined ? 'reporte' : oneOf(body.type, REPORT_TYPES, 'type'),
    category: oneOf(body.category, REPORT_CATEGORIES, 'category'),
    description: text(body.description, 'description', REPORT_MIN_DESCRIPTION),
    attachment_keys: evidenceKeys(body.attachment_keys, REPORT_MAX_EVIDENCE_PER_REQUEST, false),
    client_uuid: clientUuid,
  };
}

/** POST /api/reports/:id/comments */
export function parseCommentInput(raw: unknown): { body: string; internal: boolean } {
  const body = plainObject(raw);
  noExtraKeys(body, ['body', 'internal']);
  if (body.internal !== undefined && typeof body.internal !== 'boolean') {
    throw new BadRequestError('internal debe ser verdadero o falso.', 'VALIDATION_ERROR');
  }
  return { body: text(body.body, 'body', 1), internal: body.internal === true };
}

/** POST /api/reports/:id/evidence */
export function parseEvidenceInput(raw: unknown): { attachment_keys: string[] } {
  const body = plainObject(raw);
  noExtraKeys(body, ['attachment_keys']);
  return {
    attachment_keys: evidenceKeys(body.attachment_keys, REPORT_MAX_EVIDENCE_PER_REQUEST, true),
  };
}

export interface ChangeReportStatusInput {
  status: Exclude<ReportStatus, 'pendiente'>;
  resolution_type: ReportResolutionType | null;
  comment: string | null;
  priority: ReportPriority | null;
}

/** POST /api/reports/:id/status */
export function parseChangeStatusInput(raw: unknown): ChangeReportStatusInput {
  const body = plainObject(raw);
  noExtraKeys(body, ['status', 'resolution_type', 'comment', 'priority']);

  const status = oneOf(body.status, ['en_revision', 'resuelto', 'rechazado'] as const, 'status');

  const resolutionType =
    body.resolution_type === undefined || body.resolution_type === null
      ? null
      : oneOf(body.resolution_type, REPORT_RESOLUTION_TYPES, 'resolution_type');
  const comment =
    body.comment === undefined || body.comment === null ? null : text(body.comment, 'comment', 1);
  const priority =
    body.priority === undefined || body.priority === null
      ? null
      : oneOf(body.priority, REPORT_PRIORITIES, 'priority');

  if (status === 'resuelto' && (!resolutionType || !comment)) {
    throw new BadRequestError(
      'Para resolver indica resolution_type y un comentario con la resolución.',
      'VALIDATION_ERROR',
    );
  }
  if (status === 'rechazado' && !comment) {
    throw new BadRequestError('Para rechazar indica el motivo en comment.', 'VALIDATION_ERROR');
  }
  if (resolutionType && status !== 'resuelto') {
    throw new BadRequestError('resolution_type solo aplica al resolver.', 'VALIDATION_ERROR');
  }

  return { status, resolution_type: resolutionType, comment, priority };
}

/** POST /api/reports/:id/assign (sin assigned_to se asigna a quien llama). */
export function parseAssignInput(raw: unknown): { assigned_to: bigint | null } {
  if (raw === undefined || raw === null) return { assigned_to: null };
  const body = plainObject(raw);
  noExtraKeys(body, ['assigned_to']);
  if (body.assigned_to === undefined || body.assigned_to === null) return { assigned_to: null };
  return { assigned_to: parseReportId(body.assigned_to, 'assigned_to') };
}

export interface ReportListQuery {
  page: number;
  limit: number;
  status: ReportStatus | null;
  type: ReportType | null;
  category: ReportCategory | null;
  priority: ReportPriority | null;
  request_id: bigint | null;
  /** 'me' o el id de un usuario de Soporte. Solo para Soporte y Administrador. */
  assigned_to: 'me' | bigint | null;
  /** Folio completo o parte inicial. Solo para Soporte y Administrador. */
  q: string | null;
}

/** GET /api/reports */
export function parseReportListQuery(query: Record<string, unknown>): ReportListQuery {
  let page = 1;
  if (query.page !== undefined) {
    const parsed = typeof query.page === 'string' ? Number(query.page) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }
    page = parsed;
  }

  let limit = REPORT_DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > REPORT_MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `limit debe ser un entero entre 1 y ${REPORT_MAX_PAGE_SIZE}.`,
        'VALIDATION_ERROR',
      );
    }
    limit = parsed;
  }

  const optional = <T extends string>(value: unknown, allowed: readonly T[], field: string) =>
    value === undefined ? null : oneOf(value, allowed, field);

  let assignedTo: 'me' | bigint | null = null;
  if (query.assigned_to !== undefined) {
    assignedTo =
      query.assigned_to === 'me' ? 'me' : parseReportId(query.assigned_to, 'assigned_to');
  }

  let q: string | null = null;
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(query.q.trim())) {
      throw new BadRequestError('q debe ser un folio o parte de uno.', 'VALIDATION_ERROR');
    }
    q = query.q.trim().toUpperCase();
  }

  return {
    page,
    limit,
    status: optional(query.status, REPORT_STATUSES, 'status'),
    type: optional(query.type, REPORT_TYPES, 'type'),
    category: optional(query.category, REPORT_CATEGORIES, 'category'),
    priority: optional(query.priority, REPORT_PRIORITIES, 'priority'),
    request_id:
      query.request_id === undefined ? null : parseReportId(query.request_id, 'request_id'),
    assigned_to: assignedTo,
    q,
  };
}
