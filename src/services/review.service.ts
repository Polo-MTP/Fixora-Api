import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  branches,
  employees,
  personal_data,
  review_attachments,
  reviews,
  service_requests,
} from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { ReviewCreatedEvent } from '../events/events/domain-events.ts';
import {
  formatReviewAuthor,
  parseCreateReviewInput,
  parseReviewId,
  parseReviewPageQuery,
  type CreateReviewInput,
} from '../utils/review-validation.ts';
import { resolveSide, type ChatActor } from './chat.service.ts';
import { storageService } from './storage.service.ts';

type RequestRow = typeof service_requests.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;
type ReviewDirection = ReviewRow['direction'];
type AttachmentMime = (typeof review_attachments.$inferSelect)['mime_type'];

const EVIDENCE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
];
const EVIDENCE_URL_MINUTES = 180;

// ---------------------------------------------------------------------------
// Serialización
// ---------------------------------------------------------------------------

function signedEvidenceUrl(storageKey: string): string | null {
  try {
    return storageService.generateSignedUrl({
      file_key: storageKey,
      expires_in_minutes: EVIDENCE_URL_MINUTES,
    }).signed_url;
  } catch {
    return null;
  }
}

/** Autores y evidencias de un conjunto de reseñas, en dos consultas. */
async function loadReviewDetails(rows: ReviewRow[]) {
  const authorIds = [...new Set(rows.map((row) => row.author_id))];
  const authors = authorIds.length
    ? await db
        .select({
          userId: personal_data.user_id,
          name: personal_data.name,
          lastname: personal_data.lastname_p,
        })
        .from(personal_data)
        .where(inArray(personal_data.user_id, authorIds))
    : [];
  const authorById = new Map(authors.map((author) => [author.userId.toString(), author]));

  const attachments = rows.length
    ? await db
        .select()
        .from(review_attachments)
        .where(
          inArray(
            review_attachments.review_id,
            rows.map((row) => row.UniqueID),
          ),
        )
        .orderBy(asc(review_attachments.UniqueID))
    : [];
  const attachmentsByReview = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    const key = attachment.review_id.toString();
    const list = attachmentsByReview.get(key) ?? [];
    list.push(attachment);
    attachmentsByReview.set(key, list);
  }

  return {
    authorName: (row: ReviewRow, fallback: string) => {
      const author = authorById.get(row.author_id.toString());
      return formatReviewAuthor(author?.name, author?.lastname, fallback);
    },
    evidence: (row: ReviewRow) =>
      (attachmentsByReview.get(row.UniqueID.toString()) ?? []).map((attachment) => ({
        id: attachment.UniqueID.toString(),
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        url: signedEvidenceUrl(attachment.storage_key),
      })),
  };
}

/** Vista para quienes participan en la solicitud. */
async function serializeParticipantReviews(rows: ReviewRow[]) {
  const details = await loadReviewDetails(rows);
  return rows.map((row) => ({
    id: row.UniqueID.toString(),
    request_id: row.request_id.toString(),
    direction: row.direction,
    rating: row.rating,
    comment: row.comment,
    author_id: row.author_id.toString(),
    author_name: details.authorName(
      row,
      row.direction === 'cliente_a_proveedor' ? 'Cliente' : 'Proveedor',
    ),
    reviewee_id: row.reviewee_id.toString(),
    evidence: details.evidence(row),
    client_uuid: row.client_uuid,
    created_at: row.created_at.toISOString(),
  }));
}

/** Vista pública: sin ids de usuario ni de solicitud, solo lo que se muestra en la ficha. */
async function serializePublicReviews(rows: ReviewRow[]) {
  const details = await loadReviewDetails(rows);
  return rows.map((row) => ({
    id: row.UniqueID.toString(),
    rating: row.rating,
    comment: row.comment,
    author_name: details.authorName(row, 'Cliente'),
    created_at: row.created_at.toISOString(),
    evidence: details.evidence(row).map(({ mime_type, url }) => ({ mime_type, url })),
  }));
}

// ---------------------------------------------------------------------------
// Alta de reseñas
// ---------------------------------------------------------------------------

async function findRequest(requestId: bigint): Promise<RequestRow | undefined> {
  const [request] = await db
    .select()
    .from(service_requests)
    .where(eq(service_requests.UniqueID, requestId))
    .limit(1);
  return request;
}

async function findReview(requestId: bigint, direction: ReviewDirection) {
  const [row] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.request_id, requestId), eq(reviews.direction, direction)))
    .limit(1);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

/** Quién recibe la reseña: el técnico que atendió, o el cliente. */
async function resolveReviewee(request: RequestRow, direction: ReviewDirection): Promise<bigint> {
  if (direction === 'proveedor_a_cliente') return request.client_id;

  if (request.employee_id === null) {
    throw new ConflictError('La solicitud no tiene técnico asignado.', 'REVIEW_NOT_ALLOWED');
  }
  const [employee] = await db
    .select({ userId: employees.user_id })
    .from(employees)
    .where(eq(employees.UniqueID, request.employee_id))
    .limit(1);
  if (!employee) {
    throw new ConflictError('La solicitud no tiene técnico asignado.', 'REVIEW_NOT_ALLOWED');
  }
  return employee.userId;
}

async function validateEvidence(keys: string[], authorId: string) {
  const files: Array<{ file_key: string; mime_type: AttachmentMime; size_bytes: number }> = [];
  for (const key of keys) {
    const normalized = key.replace(/\\/g, '/');
    if (
      !(normalized.startsWith('photos/') || normalized.startsWith('evidences/')) ||
      storageService.getFileOwnerId(key) !== authorId
    ) {
      throw new ForbiddenError(
        'Solo puedes adjuntar archivos que hayas subido a tu propia cuenta (categorías photos o evidences).',
        'FILE_NOT_OWNED',
      );
    }
    const file = await storageService.getFileForDownload(key);
    if (!EVIDENCE_MIME_TYPES.includes(file.mimeType)) {
      throw new BadRequestError(
        'La evidencia debe ser una imagen JPEG, PNG o WebP, o un video MP4.',
        'INVALID_EVIDENCE_FILE_TYPE',
      );
    }
    files.push({
      file_key: key,
      mime_type: file.mimeType as AttachmentMime,
      size_bytes: file.sizeBytes,
    });
  }
  return files;
}

/** Misma reseña reenviada (mismo autor y client_uuid): se devuelve la original. Otro caso: 409. */
async function replayOrConflict(existing: ReviewRow, authorId: bigint, input: CreateReviewInput) {
  if (
    input.client_uuid !== null &&
    existing.author_id === authorId &&
    existing.client_uuid === input.client_uuid
  ) {
    const [review] = await serializeParticipantReviews([existing]);
    return { review: review!, created: false };
  }
  throw new ConflictError(
    'Esta solicitud ya fue calificada en este sentido.',
    'REVIEW_ALREADY_EXISTS',
  );
}

/**
 * POST /service-requests/:id/reviews.
 * El sentido sale de quién escribe: el cliente reseña al proveedor, y el equipo del proveedor
 * (técnico asignado, gerente o dueño) reseña al cliente. Solo con la solicitud finalizada.
 */
export async function createReview(requestId: bigint, actor: ChatActor, rawBody: unknown) {
  const input = parseCreateReviewInput(rawBody);

  const request = await findRequest(requestId);
  if (!request) throw new NotFoundError();

  const side = await resolveSide(request, actor);
  if (!side) throw new NotFoundError();

  if (request.status !== 'completada') {
    throw new ConflictError(
      'Solo puedes calificar una solicitud finalizada.',
      'REVIEW_NOT_ALLOWED',
    );
  }

  const direction: ReviewDirection =
    side === 'cliente' ? 'cliente_a_proveedor' : 'proveedor_a_cliente';
  const authorId = BigInt(actor.id);

  const existing = await findReview(requestId, direction);
  if (existing) return replayOrConflict(existing, authorId, input);

  const revieweeId = await resolveReviewee(request, direction);
  const evidence = await validateEvidence(input.attachment_keys, actor.id);

  let reviewId: bigint;
  try {
    reviewId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(reviews)
        .values({
          request_id: requestId,
          direction,
          author_id: authorId,
          reviewee_id: revieweeId,
          rating: input.rating,
          comment: input.comment,
          client_uuid: input.client_uuid,
        })
        .returning({ id: reviews.UniqueID });

      if (evidence.length) {
        await tx.insert(review_attachments).values(
          evidence.map((file) => ({
            review_id: created!.id,
            storage_key: file.file_key,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
          })),
        );
      }
      return created!.id;
    });
  } catch (error) {
    // Dos envíos a la vez: gana el primero y el otro recibe su resultado.
    if (isUniqueViolation(error)) {
      const raced = await findReview(requestId, direction);
      if (raced) return replayOrConflict(raced, authorId, input);
      // No hay reseña en este sentido: el choque es por un client_uuid que ya se usó en otra solicitud.
      throw new ConflictError(
        'Ese client_uuid ya se usó en otra reseña. Genera uno nuevo.',
        'CLIENT_UUID_IN_USE',
      );
    }
    throw error;
  }

  // El observador recalcula rating_avg y reviews_count antes de que se responda.
  await eventBus.notify(
    new ReviewCreatedEvent({
      reviewId: reviewId.toString(),
      requestId: requestId.toString(),
      direction,
      authorId: actor.id,
      revieweeId: revieweeId.toString(),
      branchId: request.branch_id?.toString() ?? null,
      rating: input.rating,
    }),
  );

  const [row] = await db.select().from(reviews).where(eq(reviews.UniqueID, reviewId)).limit(1);
  const [review] = await serializeParticipantReviews([row!]);
  return { review: review!, created: true };
}

/** GET /service-requests/:id/reviews — las reseñas de la solicitud y si ya puedes calificar. */
export async function getRequestReviews(requestId: bigint, actor: ChatActor) {
  const request = await findRequest(requestId);
  if (!request) throw new NotFoundError();

  const side = await resolveSide(request, actor);
  if (!side) throw new NotFoundError();

  const rows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.request_id, requestId))
    .orderBy(asc(reviews.UniqueID));

  const myDirection: ReviewDirection =
    side === 'cliente' ? 'cliente_a_proveedor' : 'proveedor_a_cliente';
  const alreadyReviewed = rows.some((row) => row.direction === myDirection);

  return {
    request_id: requestId.toString(),
    my_direction: myDirection,
    can_review: request.status === 'completada' && !alreadyReviewed,
    reviews: await serializeParticipantReviews(rows),
  };
}

// ---------------------------------------------------------------------------
// Lecturas públicas y para proveedores
// ---------------------------------------------------------------------------

/** Reseñas de clientes sobre una sucursal, de la más nueva a la más vieja. */
export async function listBranchReviews(branchId: bigint, page: number, limit: number) {
  const [branch] = await db
    .select({ id: branches.UniqueID })
    .from(branches)
    .where(eq(branches.UniqueID, branchId))
    .limit(1);
  if (!branch) throw new NotFoundError('Sucursal no encontrada.');

  const where = and(
    eq(service_requests.branch_id, branchId),
    eq(reviews.direction, 'cliente_a_proveedor'),
    eq(reviews.status, 'publicada'),
  );

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reviews)
    .innerJoin(service_requests, eq(service_requests.UniqueID, reviews.request_id))
    .where(where);

  const rows = await db
    .select({ review: reviews })
    .from(reviews)
    .innerJoin(service_requests, eq(service_requests.UniqueID, reviews.request_id))
    .where(where)
    .orderBy(desc(reviews.created_at), desc(reviews.UniqueID))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(countRow?.total ?? 0);
  return {
    items: await serializePublicReviews(rows.map((row) => row.review)),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

/** GET /branches/:id/reviews — mismo listado que la ficha pública, paginado. */
export async function getPublicBranchReviews(rawBranchId: unknown, rawQuery: unknown) {
  const branchId = parseReviewId(rawBranchId, 'El identificador de sucursal');
  const { page, limit } = parseReviewPageQuery((rawQuery ?? {}) as Record<string, unknown>);
  return listBranchReviews(branchId, page, limit);
}

/** Últimas reseñas que recibió un cliente; los proveedores las ven antes de aceptar. */
export async function listClientReviews(clientId: bigint, limit: number) {
  const rows = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.reviewee_id, clientId),
        eq(reviews.direction, 'proveedor_a_cliente'),
        eq(reviews.status, 'publicada'),
      ),
    )
    .orderBy(desc(reviews.created_at), desc(reviews.UniqueID))
    .limit(limit);

  const details = await loadReviewDetails(rows);
  return rows.map((row) => ({
    id: row.UniqueID.toString(),
    rating: row.rating,
    comment: row.comment,
    author_name: details.authorName(row, 'Proveedor'),
    created_at: row.created_at.toISOString(),
  }));
}
