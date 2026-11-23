import { BadRequestError } from '../errors/app-error.ts';

export const CHAT_MAX_TEXT_LENGTH = 2000;
export const CHAT_MAX_PHOTOS = 5;
export const CHAT_DEFAULT_PAGE_SIZE = 30;
export const CHAT_MAX_PAGE_SIZE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[1-9]\d{0,17}$/;

export interface SendChatMessageInput {
    client_uuid: string;
    message: string | null;
    reply_to_id: bigint | null;
    attachment_keys: string[];
}

export interface ChatPageQuery {
    limit: number;
    before: bigint | null;
    after: bigint | null;
}

function assertPlainObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestError('El cuerpo de la solicitud no es válido.', 'VALIDATION_ERROR');
    }
    return value as Record<string, unknown>;
}

function assertNoExtraKeys(body: Record<string, unknown>, allowed: string[]): void {
    const extra = Object.keys(body).filter((key) => !allowed.includes(key));
    if (extra.length) {
        throw new BadRequestError(`Campos no permitidos: ${extra.join(', ')}.`, 'VALIDATION_ERROR');
    }
}

export function parseChatId(value: unknown, field: string): bigint {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        throw new BadRequestError(`${field} debe ser un identificador válido.`, 'VALIDATION_ERROR');
    }
    return BigInt(value);
}

/** Valida el cuerpo de POST /service-requests/:id/chat/messages. */
export function parseSendMessageInput(raw: unknown): SendChatMessageInput {
    const body = assertPlainObject(raw);
    assertNoExtraKeys(body, ['client_uuid', 'message', 'reply_to_id', 'attachment_keys']);

    if (typeof body.client_uuid !== 'string' || !UUID_PATTERN.test(body.client_uuid)) {
        throw new BadRequestError('client_uuid debe ser un UUID válido.', 'VALIDATION_ERROR');
    }

    let message: string | null = null;
    if (body.message !== undefined && body.message !== null) {
        if (typeof body.message !== 'string') {
            throw new BadRequestError('message debe ser texto.', 'VALIDATION_ERROR');
        }
        const trimmed = body.message.trim();
        if (trimmed.length > CHAT_MAX_TEXT_LENGTH) {
            throw new BadRequestError(
                `message no debe exceder ${CHAT_MAX_TEXT_LENGTH} caracteres.`,
                'VALIDATION_ERROR',
            );
        }
        message = trimmed || null;
    }

    let attachmentKeys: string[] = [];
    if (body.attachment_keys !== undefined && body.attachment_keys !== null) {
        const keys = body.attachment_keys;
        if (
            !Array.isArray(keys) ||
            keys.length > CHAT_MAX_PHOTOS ||
            keys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)
        ) {
            throw new BadRequestError(
                `attachment_keys debe contener hasta ${CHAT_MAX_PHOTOS} llaves de fotografías válidas.`,
                'VALIDATION_ERROR',
            );
        }
        attachmentKeys = keys as string[];
        if (new Set(attachmentKeys).size !== attachmentKeys.length) {
            throw new BadRequestError('No repitas llaves en attachment_keys.', 'VALIDATION_ERROR');
        }
    }

    if (!message && attachmentKeys.length === 0) {
        throw new BadRequestError(
            'Escribe un mensaje o adjunta al menos una fotografía.',
            'VALIDATION_ERROR',
        );
    }

    let replyToId: bigint | null = null;
    if (body.reply_to_id !== undefined && body.reply_to_id !== null) {
        replyToId = parseChatId(body.reply_to_id, 'reply_to_id');
    }

    return {
        client_uuid: body.client_uuid.toLowerCase(),
        message,
        reply_to_id: replyToId,
        attachment_keys: attachmentKeys,
    };
}

/** Valida el cuerpo de POST /service-requests/:id/chat/read (up_to_message_id es opcional). */
export function parseMarkReadInput(raw: unknown): { upTo: bigint | null } {
    if (raw === undefined || raw === null) return { upTo: null };
    const body = assertPlainObject(raw);
    assertNoExtraKeys(body, ['up_to_message_id']);
    if (body.up_to_message_id === undefined || body.up_to_message_id === null) return { upTo: null };
    return { upTo: parseChatId(body.up_to_message_id, 'up_to_message_id') };
}

/** Valida limit, before y after de la lectura paginada. before y after no se combinan. */
export function parseChatPageQuery(query: Record<string, unknown>): ChatPageQuery {
    let limit = CHAT_DEFAULT_PAGE_SIZE;
    if (query.limit !== undefined) {
        const parsed = typeof query.limit === 'string' ? Number(query.limit) : NaN;
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > CHAT_MAX_PAGE_SIZE) {
            throw new BadRequestError(
                `limit debe ser un entero entre 1 y ${CHAT_MAX_PAGE_SIZE}.`,
                'VALIDATION_ERROR',
            );
        }
        limit = parsed;
    }

    const before = query.before === undefined ? null : parseChatId(query.before, 'before');
    const after = query.after === undefined ? null : parseChatId(query.after, 'after');
    if (before !== null && after !== null) {
        throw new BadRequestError('Usa before o after, no ambos.', 'VALIDATION_ERROR');
    }
    return { limit, before, after };
}

/** Texto corto del mensaje para el aviso push y el contador de no leídos. */
export function chatPreview(message: string | null, photoCount: number, maxLength = 100): string {
    const text = message?.trim();
    if (text) return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
    return photoCount > 1 ? 'Te envió fotografías.' : 'Te envió una fotografía.';
}
