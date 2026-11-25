import { BadRequestError } from '../errors/app-error.ts';

export const REVIEW_MAX_COMMENT_LENGTH = 1000;
export const REVIEW_MAX_EVIDENCE = 3;
export const REVIEW_DEFAULT_PAGE_SIZE = 10;
export const REVIEW_MAX_PAGE_SIZE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[1-9]\d{0,17}$/;

export interface CreateReviewInput {
  rating: number;
  comment: string | null;
  attachment_keys: string[];
  client_uuid: string | null;
}

export function parseReviewId(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new BadRequestError(`${field} debe ser un identificador válido.`, 'VALIDATION_ERROR');
  }
  return BigInt(value);
}

/** Valida el cuerpo de POST /service-requests/:id/reviews. */
export function parseCreateReviewInput(raw: unknown): CreateReviewInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
  }
  const body = raw as Record<string, unknown>;

  const extra = Object.keys(body).filter(
    (key) => !['rating', 'comment', 'attachment_keys', 'client_uuid'].includes(key),
  );
  if (extra.length) {
    throw new BadRequestError(`Campos no permitidos: ${extra.join(', ')}.`, 'VALIDATION_ERROR');
  }

  if (
    typeof body.rating !== 'number' ||
    !Number.isInteger(body.rating) ||
    body.rating < 1 ||
    body.rating > 5
  ) {
    throw new BadRequestError('rating debe ser un entero de 1 a 5.', 'VALIDATION_ERROR');
  }

  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== 'string') {
      throw new BadRequestError('comment debe ser texto.', 'VALIDATION_ERROR');
    }
    const trimmed = body.comment.trim();
    if (trimmed.length > REVIEW_MAX_COMMENT_LENGTH) {
      throw new BadRequestError(
        `comment no debe exceder ${REVIEW_MAX_COMMENT_LENGTH} caracteres.`,
        'VALIDATION_ERROR',
      );
    }
    comment = trimmed || null;
  }

  let attachmentKeys: string[] = [];
  if (body.attachment_keys !== undefined && body.attachment_keys !== null) {
    const keys = body.attachment_keys;
    if (
      !Array.isArray(keys) ||
      keys.length > REVIEW_MAX_EVIDENCE ||
      keys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)
    ) {
      throw new BadRequestError(
        `attachment_keys debe contener hasta ${REVIEW_MAX_EVIDENCE} llaves de evidencia válidas.`,
        'VALIDATION_ERROR',
      );
    }
    attachmentKeys = keys as string[];
    if (new Set(attachmentKeys).size !== attachmentKeys.length) {
      throw new BadRequestError('No repitas llaves en attachment_keys.', 'VALIDATION_ERROR');
    }
  }

  let clientUuid: string | null = null;
  if (body.client_uuid !== undefined && body.client_uuid !== null) {
    if (typeof body.client_uuid !== 'string' || !UUID_PATTERN.test(body.client_uuid)) {
      throw new BadRequestError('client_uuid debe ser un UUID válido.', 'VALIDATION_ERROR');
    }
    clientUuid = body.client_uuid.toLowerCase();
  }

  return { rating: body.rating, comment, attachment_keys: attachmentKeys, client_uuid: clientUuid };
}

/** Valida page y limit de los listados de reseñas. */
export function parseReviewPageQuery(query: Record<string, unknown>): {
  page: number;
  limit: number;
} {
  let page = 1;
  if (query.page !== undefined) {
    const parsed = typeof query.page === 'string' ? Number(query.page) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError('page debe ser un entero mayor o igual a 1.', 'VALIDATION_ERROR');
    }
    page = parsed;
  }

  let limit = REVIEW_DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > REVIEW_MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `limit debe ser un entero entre 1 y ${REVIEW_MAX_PAGE_SIZE}.`,
        'VALIDATION_ERROR',
      );
    }
    limit = parsed;
  }
  return { page, limit };
}

/** "Roberto Martínez" se publica como "Roberto M."; sin nombre se usa el texto de respaldo. */
export function formatReviewAuthor(
  name: string | null | undefined,
  lastname: string | null | undefined,
  fallback: string,
): string {
  const first = name?.trim();
  if (!first) return fallback;
  const initial = lastname?.trim() ? `${lastname.trim().charAt(0).toUpperCase()}.` : '';
  return `${first} ${initial}`.trim();
}
