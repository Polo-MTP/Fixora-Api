import type { NextFunction, Request, Response } from 'express';

import {
    BranchEmployeeError,
    createBranchEmployee,
    listBranchEmployees,
} from '../services/branch-employee.service.ts';

function parseBranchId(value: string): bigint | null {
    if (!/^[1-9]\d{0,17}$/.test(value)) return null;
    return BigInt(value);
}

function handleError(error: unknown, res: Response, next: NextFunction): void {
    if (error instanceof BranchEmployeeError) {
        res.status(error.statusCode).json({
            error: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
        });
        return;
    }
    next(error);
}

function invalidBranchId(res: Response): void {
    res.status(400).json({
        error: 'INVALID_ID',
        message: 'El identificador de la sucursal no es válido.',
    });
}

export async function listEmployees(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({
                error: 'INVALID_ACCESS_TOKEN',
                message: 'El token no es válido o ha expirado.',
            });
            return;
        }

        const rawBranchId = req.params.id;
        const branchId = typeof rawBranchId === 'string' ? parseBranchId(rawBranchId) : null;
        if (branchId === null) {
            invalidBranchId(res);
            return;
        }

        const data = await listBranchEmployees(branchId, BigInt(req.user.id), req.user.role);
        res.status(200).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        handleError(error, res, next);
    }
}

export async function createEmployee(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({
                error: 'INVALID_ACCESS_TOKEN',
                message: 'El token no es válido o ha expirado.',
            });
            return;
        }

        const rawBranchId = req.params.id;
        const branchId = typeof rawBranchId === 'string' ? parseBranchId(rawBranchId) : null;
        if (branchId === null) {
            invalidBranchId(res);
            return;
        }

        const data = await createBranchEmployee(branchId, BigInt(req.user.id), req.user.role, req.body);

        res.status(201).json({
            success: true,
            message: 'Operación realizada correctamente.',
            data,
        });
    } catch (error) {
        handleError(error, res, next);
    }
}
