
import type { Request, Response } from 'express';

import {
    AccountError,
    getMyAccount,
    updateMyAccount,
    changeMyPassword,
    getMyAddresses,
    getMyAddress,
    createMyAddress,
    updateMyAddress,
    setMainAddress,
    deactivateMyAddress
} from '../services/account.service.ts';

// ============================================================
// OBTENER USUARIO AUTENTICADO
// ============================================================

function getAuthenticatedContext(req: Request) {
    if (!req.user) {
        throw new AccountError(
            401,
            'ACCOUNT_UNAUTHENTICATED',
            'Debes iniciar sesión para realizar esta operación.'
        );
    }

    if (!/^[1-9]\d*$/.test(req.user.id)) {
        throw new AccountError(
            401,
            'ACCOUNT_INVALID_USER_ID',
            'El identificador del usuario no es válido.'
        );
    }

    return {
        userId: BigInt(req.user.id),
        sessionId: req.user.sessionId
    };
}

// ============================================================
// VALIDAR ID DE DIRECCIÓN
// ============================================================

function parseAddressId(
    value: string | string[] | undefined
): bigint {
    if (
        typeof value !== 'string' ||
        !/^[1-9]\d{0,17}$/.test(value)
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_ADDRESS_ID',
            'El identificador de dirección no es válido.'
        );
    }

    return BigInt(value);
}

// ============================================================
// VALIDAR BODY
// ============================================================

function validateBody(body: unknown): void {
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body)
    ) {
        throw new AccountError(
            400,
            'ACCOUNT_INVALID_INPUT',
            'El cuerpo de la solicitud no es válido.'
        );
    }
}

// ============================================================
// MANEJO DE ERRORES
// ============================================================

function handleError(res: Response, error: unknown) {
    if (error instanceof AccountError) {
        return res.status(error.statusCode).json({
            error: error.code,
            message: error.message
        });
    }

    console.error('Error en el módulo Mi Cuenta:', error);

    return res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Error interno del servidor.'
    });
}

// ============================================================
// GET /api/account/me
// CONSULTAR MI CUENTA
// ============================================================

export async function getMe(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);

        const data = await getMyAccount(userId);

        return res.status(200).json({
            success: true,
            message: 'Datos de la cuenta obtenidos correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// PATCH /api/account/me
// ACTUALIZAR DATOS PERSONALES
// ============================================================

export async function updateMe(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);

        validateBody(req.body);

        const data = await updateMyAccount(
            userId,
            req.body
        );

        return res.status(200).json({
            success: true,
            message: 'Datos personales actualizados correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// PATCH /api/account/me/password
// CAMBIAR CONTRASEÑA
// ============================================================

export async function changePassword(
    req: Request,
    res: Response
) {
    try {
        const { userId, sessionId } =
            getAuthenticatedContext(req);

        validateBody(req.body);

        const data = await changeMyPassword(
            userId,
            sessionId,
            req.body
        );

        return res.status(200).json({
            success: true,
            message: 'Contraseña actualizada correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// GET /api/account/addresses
// CONSULTAR MIS DIRECCIONES
// ============================================================

export async function listAddresses(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);

        const data = await getMyAddresses(userId);

        return res.status(200).json({
            success: true,
            message: 'Direcciones obtenidas correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// GET /api/account/addresses/:id
// CONSULTAR UNA DIRECCIÓN
// ============================================================

export async function getAddress(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);
        const addressId = parseAddressId(req.params.id);

        const data = await getMyAddress(
            userId,
            addressId
        );

        return res.status(200).json({
            success: true,
            message: 'Dirección obtenida correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// POST /api/account/addresses
// CREAR DIRECCIÓN
// ============================================================

export async function createAddress(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);

        validateBody(req.body);

        const data = await createMyAddress(
            userId,
            req.body
        );

        return res.status(201).json({
            success: true,
            message: 'Dirección guardada correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// PATCH /api/account/addresses/:id
// MODIFICAR DIRECCIÓN
// ============================================================

export async function updateAddress(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);
        const addressId = parseAddressId(req.params.id);

        validateBody(req.body);

        const data = await updateMyAddress(
            userId,
            addressId,
            req.body
        );

        return res.status(200).json({
            success: true,
            message: 'Dirección actualizada correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// PATCH /api/account/addresses/:id/main
// ESTABLECER DIRECCIÓN PRINCIPAL
// ============================================================

export async function setMain(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);
        const addressId = parseAddressId(req.params.id);

        const data = await setMainAddress(
            userId,
            addressId
        );

        return res.status(200).json({
            success: true,
            message: 'Dirección principal actualizada correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}

// ============================================================
// DELETE /api/account/addresses/:id
// DESACTIVAR DIRECCIÓN
// ============================================================

export async function deactivateAddress(
    req: Request,
    res: Response
) {
    try {
        const { userId } = getAuthenticatedContext(req);
        const addressId = parseAddressId(req.params.id);

        const data = await deactivateMyAddress(
            userId,
            addressId
        );

        return res.status(200).json({
            success: true,
            message: 'Dirección desactivada correctamente.',
            data
        });
    } catch (error) {
        return handleError(res, error);
    }
}
