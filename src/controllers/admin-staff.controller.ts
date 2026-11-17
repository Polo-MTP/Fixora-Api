
import type {
    Request,
    Response,
    NextFunction
} from 'express';

import {
    AdminStaffError,
    createStaff
} from '../services/admin-staff.service.ts';

const AVAILABLE_ROLES = [
    'administrador',
    'soporte'
];

const AVAILABLE_STATUSES = [
    'activo'
];

// ============================================================
// MANEJO DE ERRORES
// ============================================================

function handleStaffError(
    error: unknown,
    res: Response,
    next: NextFunction
): void {
    if (error instanceof AdminStaffError) {
        if (error.code === 'VALIDATION_ERROR') {
            res.status(400).json({
                error: error.code,
                message: error.message,
                details: error.details ?? [],
                availableRoles: AVAILABLE_ROLES,
                availableStatuses: AVAILABLE_STATUSES
            });

            return;
        }

        res.status(error.statusCode).json({
            error: error.code,
            message: error.message
        });

        return;
    }

    next(error);
}

// ============================================================
// CREAR ADMINISTRADOR O SOPORTE
// POST /api/admin/staff
// ============================================================

export async function createStaffController(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({
                error: 'INVALID_ACCESS_TOKEN',
                message: 'El token no es válido o ha expirado.'
            });

            return;
        }

        if (
            req.user.role.trim().toLowerCase() !== 'administrador'
        ) {
            res.status(403).json({
                error: 'INSUFFICIENT_PERMISSIONS',
                message: 'No tienes permisos para realizar esta acción.'
            });

            return;
        }

        const actorId = BigInt(req.user.id);

        const data = await createStaff(
            actorId,
            req.body
        );

        res.status(201).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data
        });
    } catch (error: unknown) {
        handleStaffError(error, res, next);
    }
}
