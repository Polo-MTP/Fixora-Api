import type { Request, Response, NextFunction } from 'express';
import { AppError, UnauthorizedError } from '../errors/app-error.ts';
import { notificationsService } from '../services/notifications.service.ts';

function getUserId(req: Request): string {
    if (!req.user?.id) {
        throw new UnauthorizedError('Debes iniciar sesión para realizar esta operación.');
    }
    if (!/^[1-9]\d{0,17}$/.test(req.user.id)) {
        throw new UnauthorizedError('El identificador del usuario no es válido.');
    }
    return req.user.id;
}

function parseInteger(value: unknown, field: string, fallback: number, max?: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        throw new AppError(`El parámetro ${field} debe ser un entero positivo.`, 400, 'VALIDATION_ERROR');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max)) {
        throw new AppError(`El parámetro ${field} está fuera del rango permitido.`, 400, 'VALIDATION_ERROR');
    }
    return parsed;
}

export class NotificationsController {
    async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = getUserId(req);
            let unread: boolean | undefined;
            if (req.query.unread !== undefined) {
                if (req.query.unread !== 'true' && req.query.unread !== 'false') {
                    throw new AppError('El parámetro unread debe ser true o false.', 400, 'VALIDATION_ERROR');
                }
                unread = req.query.unread === 'true';
            }

            const page = parseInteger(req.query.page, 'page', 1);
            const limit = parseInteger(req.query.limit, 'limit', 20, 100);
            const result = await notificationsService.list(userId, { unread, page, limit });

            res.status(200).json({
                success: true,
                message: 'Operación realizada correctamente.',
                ...result,
            });
        } catch (error) {
            next(error);
        }
    }

    async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = getUserId(req);
            const id = req.params.id;
            if (typeof id !== 'string') {
                throw new AppError(
                    'El identificador de notificación no es válido.',
                    400,
                    'INVALID_NOTIFICATION_ID',
                );
            }
            await notificationsService.markAsRead(userId, id);
            res.status(200).json({ success: true, message: 'Operación realizada correctamente.' });
        } catch (error) {
            next(error);
        }
    }

    async markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = getUserId(req);
            await notificationsService.markAllAsRead(userId);
            res.status(200).json({ success: true, message: 'Operación realizada correctamente.' });
        } catch (error) {
            next(error);
        }
    }
}

export const notificationsController = new NotificationsController();
