import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.ts';
import {
    createServiceRequest,
    getBranchAvailability,
} from '../services/service-request-creation.service.ts';

function parseId(value: unknown, field: string): bigint {
    if (typeof value !== 'string' || !/^[1-9]\d{0,17}$/.test(value)) {
        throw new AppError(`${field} no es válido.`, 400, 'VALIDATION_ERROR');
    }
    return BigInt(value);
}

function actorFromRequest(req: Request) {
    if (!req.user) throw new AppError('Debes iniciar sesión.', 401, 'AUTHENTICATION_REQUIRED');
    return { id: req.user.id, role: req.user.role };
}

export async function createServiceRequestController(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const data = await createServiceRequest(actorFromRequest(req), req.body);
        return res.status(201).json({
            success: true,
            message: 'Solicitud enviada al proveedor.',
            data,
        });
    } catch (error) {
        return next(error);
    }
}

export async function getBranchAvailabilityController(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const branchId = parseId(req.params.id, 'id');
        const categoryId = parseId(req.query.category_id, 'category_id');
        if (typeof req.query.date !== 'string') {
            throw new AppError(
                'date es obligatorio y debe tener formato YYYY-MM-DD.',
                400,
                'VALIDATION_ERROR',
            );
        }
        const data = await getBranchAvailability(branchId, categoryId, req.query.date);
        return res.status(200).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        return next(error);
    }
}
