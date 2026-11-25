import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  branches,
  business_supplier,
  conversations,
  employees,
  message_attachments,
  personal_data,
  reports,
  request_messages,
  service_requests,
  suppliers,
} from '../database/schema/tables.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../errors/app-error.ts';
import { eventBus } from '../events/event-bus.ts';
import { ChatMessageSentEvent, ChatMessagesReadEvent } from '../events/events/domain-events.ts';
import {
  chatPreview,
  parseChatPageQuery,
  parseMarkReadInput,
  parseSendMessageInput,
  type ChatPageQuery,
} from '../utils/chat-validation.ts';
import { storageService } from './storage.service.ts';

// ---------------------------------------------------------------------------
// Tipos y constantes
// ---------------------------------------------------------------------------

export interface ChatActor {
  id: string;
  role: string;
}

/** Lado de la conversación: el cliente, o cualquiera del equipo del proveedor. */
export type ChatSide = 'cliente' | 'proveedor';

type RequestRow = typeof service_requests.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type AttachmentMime = (typeof message_attachments.$inferSelect)['mime_type'];

/** Estados en los que se puede escribir. En los demás el chat queda de solo lectura. */
const CHAT_OPEN_STATUSES: readonly string[] = ['aceptada', 'agendada', 'en_camino', 'llegado'];

const IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_URL_MINUTES = 60;
const REPLY_PREVIEW_LENGTH = 140;

interface MessageRow {
  id: bigint;
  conversationId: bigint;
  senderId: bigint;
  message: string | null;
  replyId: bigint | null;
  clientUuid: string | null;
  readAt: Date | null;
  createdAt: Date;
  senderName: string | null;
  senderLastname: string | null;
}

// ---------------------------------------------------------------------------
// Acceso: quién participa en la conversación de una solicitud
// ---------------------------------------------------------------------------

async function findRequest(requestId: bigint): Promise<RequestRow | undefined> {
  const [request] = await db
    .select()
    .from(service_requests)
    .where(eq(service_requests.UniqueID, requestId))
    .limit(1);
  return request;
}

/**
 * Participantes: el cliente dueño, el técnico asignado, el gerente de la sucursal y el proveedor
 * dueño de la sucursal. A diferencia de la sala `requests:<id>` del WebSocket, un técnico al que
 * solo se le notificó la solicitud NO participa: el chat empieza hasta que alguien la acepta.
 */
export async function resolveSide(request: RequestRow, actor: ChatActor): Promise<ChatSide | null> {
  const actorId = BigInt(actor.id);
  if (request.client_id === actorId) return 'cliente';
  if (request.employee_id === null) return null;

  const role = actor.role.trim().toLowerCase();

  if (role === 'empleado' || role === 'gerente') {
    const [assigned] = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(
        and(
          eq(employees.UniqueID, request.employee_id),
          eq(employees.user_id, actorId),
          eq(employees.active, true),
        ),
      )
      .limit(1);
    if (assigned) return 'proveedor';

    if (role === 'gerente' && request.branch_id !== null) {
      const [managed] = await db
        .select({ id: employees.UniqueID })
        .from(employees)
        .where(
          and(
            eq(employees.user_id, actorId),
            eq(employees.branch_id, request.branch_id),
            eq(employees.active, true),
          ),
        )
        .limit(1);
      if (managed) return 'proveedor';
    }
    return null;
  }

  if (role === 'proveedor' && request.branch_id !== null) {
    const [owned] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .innerJoin(business_supplier, eq(branches.business_id, business_supplier.business_id))
      .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
      .where(
        and(
          eq(branches.UniqueID, request.branch_id),
          eq(suppliers.user_id, actorId),
          eq(suppliers.active, true),
          eq(business_supplier.active, true),
        ),
      )
      .limit(1);
    if (owned) return 'proveedor';
  }

  return null;
}

/** Lo usa el WebSocket para decidir si un socket puede entrar a la sala `chats:<id>`. */
export async function canAccessChat(
  userId: string,
  role: string,
  requestId: bigint,
): Promise<boolean> {
  const request = await findRequest(requestId);
  if (!request || request.employee_id === null) return false;
  return (await resolveSide(request, { id: userId, role })) !== null;
}

function isChatOpen(request: RequestRow): boolean {
  return request.employee_id !== null && CHAT_OPEN_STATUSES.includes(request.status);
}

async function findConversation(requestId: bigint): Promise<ConversationRow | undefined> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.request_id, requestId))
    .limit(1);
  return conversation;
}

async function createConversation(requestId: bigint): Promise<ConversationRow> {
  const [created] = await db
    .insert(conversations)
    .values({ request_id: requestId })
    .onConflictDoNothing({ target: conversations.request_id })
    .returning();
  if (created) return created;

  // Otra petición la creó en el mismo instante.
  const existing = await findConversation(requestId);
  if (!existing) {
    throw new ConflictError('No fue posible abrir el chat de la solicitud.', 'CHAT_NOT_AVAILABLE');
  }
  return existing;
}

/**
 * Carga la solicitud y la conversación para un participante. La conversación normalmente ya
 * existe (la crea la aceptación); si la solicitud se aceptó antes de esta funcionalidad, o
 * nació agendada con técnico, se crea aquí la primera vez que alguien la consulta.
 */
async function loadChat(requestId: bigint, actor: ChatActor) {
  const request = await findRequest(requestId);
  if (!request) throw new NotFoundError();

  const side = await resolveSide(request, actor);
  if (!side) throw new NotFoundError();

  const canSend = isChatOpen(request);
  let conversation = await findConversation(requestId);
  if (!conversation) {
    if (!canSend) {
      throw new ConflictError(
        request.employee_id === null
          ? 'El chat estará disponible cuando un técnico acepte la solicitud.'
          : 'El chat de esta solicitud no está disponible.',
        'CHAT_NOT_AVAILABLE',
      );
    }
    conversation = await createConversation(requestId);
  }
  return { request, side, conversation, canSend };
}

// ---------------------------------------------------------------------------
// Lectura y serialización de mensajes
// ---------------------------------------------------------------------------

function selectMessages() {
  return db
    .select({
      id: request_messages.UniqueID,
      conversationId: request_messages.conversation_id,
      senderId: request_messages.sender_id,
      message: request_messages.message,
      replyId: request_messages.message_reply_id,
      clientUuid: request_messages.client_uuid,
      readAt: request_messages.read_at,
      createdAt: request_messages.created_at,
      senderName: personal_data.name,
      senderLastname: personal_data.lastname_p,
    })
    .from(request_messages)
    .leftJoin(personal_data, eq(personal_data.user_id, request_messages.sender_id));
}

function signedPhotoUrl(storageKey: string): string | null {
  try {
    return storageService.generateSignedUrl({
      file_key: storageKey,
      expires_in_minutes: PHOTO_URL_MINUTES,
    }).signed_url;
  } catch {
    return null;
  }
}

function fullName(row: Pick<MessageRow, 'senderName' | 'senderLastname'>): string | null {
  const name = [row.senderName, row.senderLastname].filter(Boolean).join(' ').trim();
  return name || null;
}

async function serializeMessages(rows: MessageRow[], request: RequestRow) {
  if (!rows.length) return [];

  const replyIds = [
    ...new Set(rows.map((row) => row.replyId).filter((id): id is bigint => id !== null)),
  ];
  const replied = replyIds.length
    ? await db
        .select({
          id: request_messages.UniqueID,
          senderId: request_messages.sender_id,
          message: request_messages.message,
        })
        .from(request_messages)
        .where(inArray(request_messages.UniqueID, replyIds))
    : [];

  const attachmentRows = await db
    .select({
      id: message_attachments.UniqueID,
      messageId: message_attachments.message_id,
      storageKey: message_attachments.storage_key,
      mimeType: message_attachments.mime_type,
      sizeBytes: message_attachments.size_bytes,
    })
    .from(message_attachments)
    .where(inArray(message_attachments.message_id, [...rows.map((row) => row.id), ...replyIds]))
    .orderBy(asc(message_attachments.UniqueID));

  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const key = attachment.messageId.toString();
    const list = attachmentsByMessage.get(key) ?? [];
    list.push(attachment);
    attachmentsByMessage.set(key, list);
  }
  const repliedById = new Map(replied.map((row) => [row.id.toString(), row]));

  return rows.map((row) => {
    const reply = row.replyId !== null ? repliedById.get(row.replyId.toString()) : undefined;
    const replyText = reply?.message?.trim() ?? null;
    return {
      id: row.id.toString(),
      conversation_id: row.conversationId.toString(),
      request_id: request.UniqueID.toString(),
      sender_id: row.senderId.toString(),
      sender_name: fullName(row),
      sender_side: (row.senderId === request.client_id ? 'cliente' : 'proveedor') as ChatSide,
      message: row.message,
      reply_to: reply
        ? {
            id: reply.id.toString(),
            sender_id: reply.senderId.toString(),
            message:
              replyText && replyText.length > REPLY_PREVIEW_LENGTH
                ? `${replyText.slice(0, REPLY_PREVIEW_LENGTH - 3)}...`
                : replyText,
            has_attachments: (attachmentsByMessage.get(reply.id.toString()) ?? []).length > 0,
          }
        : null,
      attachments: (attachmentsByMessage.get(row.id.toString()) ?? []).map((attachment) => ({
        id: attachment.id.toString(),
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        url: signedPhotoUrl(attachment.storageKey),
      })),
      client_uuid: row.clientUuid,
      read_at: row.readAt ? row.readAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
    };
  });
}

async function fetchMessagePage(
  conversation: ConversationRow,
  request: RequestRow,
  query: ChatPageQuery,
) {
  const ascending = query.after !== null;
  const rows: MessageRow[] = await selectMessages()
    .where(
      and(
        eq(request_messages.conversation_id, conversation.UniqueID),
        query.before !== null ? lt(request_messages.UniqueID, query.before) : undefined,
        query.after !== null ? gt(request_messages.UniqueID, query.after) : undefined,
      ),
    )
    .orderBy(ascending ? asc(request_messages.UniqueID) : desc(request_messages.UniqueID))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  // Sin cursor, o con before, se pagina hacia atrás: se entrega en orden cronológico.
  if (!ascending) page.reverse();
  const messages = await serializeMessages(page, request);

  return {
    messages,
    pagination: {
      limit: query.limit,
      has_more: hasMore,
      next_before: !ascending && hasMore && messages.length ? messages[0]!.id : null,
      next_after:
        ascending && hasMore && messages.length ? messages[messages.length - 1]!.id : null,
    },
  };
}

/** Mensajes de la contraparte que el lector aún no marca como leídos. */
function counterpartMessages(side: ChatSide, clientId: bigint) {
  return side === 'cliente'
    ? ne(request_messages.sender_id, clientId)
    : eq(request_messages.sender_id, clientId);
}

async function countUnread(
  conversation: ConversationRow,
  request: RequestRow,
  side: ChatSide,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(request_messages)
    .where(
      and(
        eq(request_messages.conversation_id, conversation.UniqueID),
        isNull(request_messages.read_at),
        counterpartMessages(side, request.client_id),
      ),
    );
  return row?.total ?? 0;
}

function serializeConversation(
  conversation: ConversationRow,
  request: RequestRow,
  canSend: boolean,
  unreadCount: number,
) {
  return {
    id: conversation.UniqueID.toString(),
    request_id: request.UniqueID.toString(),
    status: canSend ? 'abierta' : 'cerrada',
    can_send: canSend,
    unread_count: unreadCount,
    created_at: conversation.created_at.toISOString(),
  };
}

/** GET /service-requests/:id/chat — conversación y mensajes, con paginación por cursor. */
export async function getChat(requestId: bigint, actor: ChatActor, rawQuery: unknown) {
  const query = parseChatPageQuery((rawQuery ?? {}) as Record<string, unknown>);
  const { request, side, conversation, canSend } = await loadChat(requestId, actor);

  const [page, unreadCount] = await Promise.all([
    fetchMessagePage(conversation, request, query),
    countUnread(conversation, request, side),
  ]);
  return {
    conversation: serializeConversation(conversation, request, canSend, unreadCount),
    ...page,
  };
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

async function findByClientUuid(conversationId: bigint, senderId: bigint, clientUuid: string) {
  const [row] = await selectMessages()
    .where(
      and(
        eq(request_messages.conversation_id, conversationId),
        eq(request_messages.sender_id, senderId),
        eq(request_messages.client_uuid, clientUuid),
      ),
    )
    .limit(1);
  return row;
}

async function validatePhotos(keys: string[], senderId: string) {
  const photos: Array<{ file_key: string; mime_type: AttachmentMime; size_bytes: number }> = [];
  for (const key of keys) {
    if (
      !key.replace(/\\/g, '/').startsWith(`photos/${senderId}/`) ||
      storageService.getFileOwnerId(key) !== senderId
    ) {
      throw new ForbiddenError(
        'Solo puedes adjuntar fotografías que hayas subido a tu propia cuenta.',
        'FILE_NOT_OWNED',
      );
    }
    const file = await storageService.getFileForDownload(key);
    if (!IMAGE_MIME_TYPES.includes(file.mimeType)) {
      throw new BadRequestError(
        'El chat solo acepta fotografías JPEG, PNG o WebP.',
        'INVALID_ATTACHMENT_TYPE',
      );
    }
    photos.push({
      file_key: key,
      mime_type: file.mimeType as AttachmentMime,
      size_bytes: file.sizeBytes,
    });
  }
  return photos;
}

/** A quién se le avisa: siempre la contraparte de quien escribe. */
async function resolveRecipients(request: RequestRow, side: ChatSide): Promise<string[]> {
  if (side === 'proveedor') return [request.client_id.toString()];
  if (request.employee_id === null) return [];

  const [employee] = await db
    .select({ userId: employees.user_id })
    .from(employees)
    .where(eq(employees.UniqueID, request.employee_id))
    .limit(1);
  return employee ? [employee.userId.toString()] : [];
}

/**
 * POST /service-requests/:id/chat/messages.
 * `created: false` indica que el client_uuid ya existía y se devuelve el mensaje original.
 */
export async function sendChatMessage(requestId: bigint, actor: ChatActor, rawBody: unknown) {
  const input = parseSendMessageInput(rawBody);
  const { request, side, conversation, canSend } = await loadChat(requestId, actor);
  const senderId = BigInt(actor.id);

  // Reintento del mismo mensaje: se responde con el original, incluso si el chat ya se cerró.
  const duplicate = await findByClientUuid(conversation.UniqueID, senderId, input.client_uuid);
  if (duplicate) {
    const [message] = await serializeMessages([duplicate], request);
    return { message: message!, created: false };
  }

  if (!canSend) {
    throw new ConflictError(
      'La solicitud ya terminó y el chat quedó de solo lectura.',
      'CHAT_CLOSED',
    );
  }

  if (input.reply_to_id !== null) {
    const [target] = await db
      .select({ id: request_messages.UniqueID })
      .from(request_messages)
      .where(
        and(
          eq(request_messages.UniqueID, input.reply_to_id),
          eq(request_messages.conversation_id, conversation.UniqueID),
        ),
      )
      .limit(1);
    if (!target) {
      throw new BadRequestError(
        'reply_to_id no pertenece a esta conversación.',
        'INVALID_REPLY_TARGET',
      );
    }
  }

  const photos = await validatePhotos(input.attachment_keys, actor.id);

  let messageId: bigint;
  try {
    messageId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(request_messages)
        .values({
          conversation_id: conversation.UniqueID,
          sender_id: senderId,
          message: input.message,
          message_reply_id: input.reply_to_id,
          client_uuid: input.client_uuid,
        })
        .returning({ id: request_messages.UniqueID });

      if (photos.length) {
        await tx.insert(message_attachments).values(
          photos.map((photo) => ({
            message_id: created!.id,
            storage_key: photo.file_key,
            mime_type: photo.mime_type,
            size_bytes: photo.size_bytes,
          })),
        );
      }
      return created!.id;
    });
  } catch (error) {
    // Dos envíos simultáneos con el mismo client_uuid: gana el primero y el otro lo recibe igual.
    if (isUniqueViolation(error)) {
      const raced = await findByClientUuid(conversation.UniqueID, senderId, input.client_uuid);
      if (raced) {
        const [message] = await serializeMessages([raced], request);
        return { message: message!, created: false };
      }
    }
    throw error;
  }

  const [row] = await selectMessages().where(eq(request_messages.UniqueID, messageId)).limit(1);
  const [message] = await serializeMessages([row!], request);

  await eventBus.notify(
    new ChatMessageSentEvent({
      requestId: request.UniqueID.toString(),
      conversationId: conversation.UniqueID.toString(),
      messageId: messageId.toString(),
      senderId: actor.id,
      senderName: message!.sender_name ?? 'Fixora',
      recipientUserIds: await resolveRecipients(request, side),
      preview: chatPreview(input.message, photos.length),
      hasAttachments: photos.length > 0,
      message: message as unknown as Record<string, unknown>,
    }),
  );

  return { message: message!, created: true };
}

// ---------------------------------------------------------------------------
// Marca de leído
// ---------------------------------------------------------------------------

/**
 * POST /service-requests/:id/chat/read.
 * Marca como leídos los mensajes de la contraparte (todos, o hasta up_to_message_id).
 */
export async function markChatRead(requestId: bigint, actor: ChatActor, rawBody: unknown) {
  const { upTo } = parseMarkReadInput(rawBody);
  const { request, side, conversation } = await loadChat(requestId, actor);
  const readAt = new Date();

  const updated = await db
    .update(request_messages)
    .set({ read_at: readAt })
    .where(
      and(
        eq(request_messages.conversation_id, conversation.UniqueID),
        isNull(request_messages.read_at),
        counterpartMessages(side, request.client_id),
        upTo !== null ? lte(request_messages.UniqueID, upTo) : undefined,
      ),
    )
    .returning({ id: request_messages.UniqueID });

  const messageIds = updated.map((row) => row.id.toString());
  if (messageIds.length) {
    await eventBus.notify(
      new ChatMessagesReadEvent({
        requestId: request.UniqueID.toString(),
        conversationId: conversation.UniqueID.toString(),
        readerId: actor.id,
        messageIds,
        readAt: readAt.toISOString(),
      }),
    );
  }

  return {
    marked: messageIds.length,
    message_ids: messageIds,
    read_at: messageIds.length ? readAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Lectura para Soporte desde un reporte
// ---------------------------------------------------------------------------

/**
 * GET /reports/:reportId/conversation — solo lectura. Soporte entra a la conversación de la
 * solicitud ligada al reporte; no escribe ni marca nada como leído.
 */
export async function getReportConversation(reportId: bigint, actor: ChatActor, rawQuery: unknown) {
  const role = actor.role.trim().toLowerCase();
  if (role !== 'soporte' && role !== 'administrador') {
    throw new ForbiddenError(
      'No tienes permisos para consultar conversaciones de reportes.',
      'INSUFFICIENT_PERMISSIONS',
    );
  }
  const query = parseChatPageQuery((rawQuery ?? {}) as Record<string, unknown>);

  const [report] = await db
    .select({ id: reports.UniqueID, requestId: reports.request_id })
    .from(reports)
    .where(eq(reports.UniqueID, reportId))
    .limit(1);
  if (!report) throw new NotFoundError('El reporte no existe.');

  const empty = {
    report_id: report.id.toString(),
    request_id: report.requestId?.toString() ?? null,
    conversation: null,
    messages: [],
    pagination: { limit: query.limit, has_more: false, next_before: null, next_after: null },
  };
  if (report.requestId === null) return empty;

  const [request, conversation] = await Promise.all([
    findRequest(report.requestId),
    findConversation(report.requestId),
  ]);
  if (!request || !conversation) return empty;

  const page = await fetchMessagePage(conversation, request, query);
  return {
    report_id: report.id.toString(),
    request_id: request.UniqueID.toString(),
    conversation: {
      id: conversation.UniqueID.toString(),
      status: isChatOpen(request) ? 'abierta' : 'cerrada',
      read_only: true,
      created_at: conversation.created_at.toISOString(),
    },
    ...page,
  };
}
