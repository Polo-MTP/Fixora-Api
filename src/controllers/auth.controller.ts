
import type { Request, Response, NextFunction } from 'express';

import {
    AuthError,
    login,
    refreshSession,
    logout,
} from '../services/auth.service.ts';

function handleAuthError(
    error: unknown,
    res: Response,
    next: NextFunction,
): void {
    if (error instanceof AuthError) {
        res.status(error.statusCode).json({
            error: error.code,
            message: error.message,
        });
        return;
    }

    next(error);
}

export async function loginController(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const body = req.body ?? {};
        const { email, password } = body;

        if (
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !email.trim() ||
            !password
        ) {
            res.status(400).json({
                error: 'INVALID_INPUT',
                message:
                    'Debes proporcionar email y password como cadenas de texto no vacías.',
            });
            return;
        }

        const result = await login(email.trim().toLowerCase(), password);

        res.status(200).json(result);
    } catch (error: unknown) {
        handleAuthError(error, res, next);
    }
}

export async function refreshController(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const body = req.body ?? {};
        const { refreshToken } = body;

        if (
            typeof refreshToken !== 'string' ||
            !refreshToken.trim()
        ) {
            res.status(400).json({
                error: 'REFRESH_TOKEN_REQUIRED',
                message: 'Debes proporcionar el token de renovación.',
            });
            return;
        }

        const result = await refreshSession(refreshToken.trim());

        res.status(200).json(result);
    } catch (error: unknown) {
        handleAuthError(error, res, next);
    }
}

export async function logoutController(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const body = req.body ?? {};
        const { refreshToken } = body;

        if (
            typeof refreshToken !== 'string' ||
            !refreshToken.trim()
        ) {
            res.status(400).json({
                error: 'REFRESH_TOKEN_REQUIRED',
                message: 'Debes proporcionar el token de renovación.',
            });
            return;
        }

        const result = await logout(refreshToken.trim());

        res.status(200).json(result);
    } catch (error: unknown) {
        handleAuthError(error, res, next);
    }
}
