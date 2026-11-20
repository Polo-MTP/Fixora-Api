import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
    getChat,
    getReportConversation,
    markChatRead,
    sendChatMessage,
} from '../services/chat.service.ts';

function parseId(value: unknown, message: string): bigint {
    if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
        throw new AppError(message, 400, 'INVALID_ID');
    }
    return BigInt(value);
}

function actorFromRequest(req: Request) {
    if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
    return { id: req.user.id, role: req.user.role };
}

export async function getChatController(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await getChat(
            parseId(req.params.id, 'El identificador de solicitud no es válido.'),
            actorFromRequest(req),
            req.query,
        );
        return res.status(200).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        return next(error);
    }
}

export async function sendChatMessageController(req: Request, res: Response, next: NextFunction) {
    try {
        const { message, created } = await sendChatMessage(
            parseId(req.params.id, 'El identificador de solicitud no es válido.'),
            actorFromRequest(req),
            req.body,
        );
        // 201 al crear; 200 cuando el client_uuid ya existía y se devuelve el mensaje original.
        return res.status(created ? 201 : 200).json({
            success: true,
            message: created ? 'Mensaje enviado correctamente.' : 'El mensaje ya había sido enviado.',
            data: message,
        });
    } catch (error) {
        return next(error);
    }
}

export async function markChatReadController(req: Request, res: Response, next: NextFunction) {
    try {
        const data = await markChatRead(
            parseId(req.params.id, 'El identificador de solicitud no es válido.'),
            actorFromRequest(req),
            req.body,
        );
        return res.status(200).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        return next(error);
    }
}

export async function getReportConversationController(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const data = await getReportConversation(
            parseId(req.params.reportId, 'El identificador del reporte no es válido.'),
            actorFromRequest(req),
            req.query,
        );
        return res.status(200).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        return next(error);
    }
}
