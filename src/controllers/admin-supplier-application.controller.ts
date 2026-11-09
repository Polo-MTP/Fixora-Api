import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../errors/app-error.ts';
import { adminSupplierApplicationService } from '../services/admin-supplier-application.service.ts';

function getParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : (value ?? '');
}

function getQueryString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value;
}

function getQueryInteger(value: unknown, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return Number.NaN;
    return Number(value);
}

export class AdminSupplierApplicationController {
    async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await adminSupplierApplicationService.listApplications({
                state: getQueryString(req.query.state),
                search: getQueryString(req.query.search),
                page: getQueryInteger(req.query.page, 1),
                limit: getQueryInteger(req.query.limit, 20),
            });

            res.status(200).json({
                success: true,
                message: 'Operación realizada correctamente.',
                data: result.data,
                pagination: result.pagination,
            });
        } catch (error) {
            next(error);
        }
    }

    async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await adminSupplierApplicationService.getApplicationDetail(
                getParam(req.params.id),
            );
            res.status(200).json({
                success: true,
                message: 'Operación realizada correctamente.',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async reviewDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user?.id) {
                throw new UnauthorizedError('Debes iniciar sesión para revisar documentos.');
            }

            const data = await adminSupplierApplicationService.reviewDocument({
                documentId: getParam(req.params.id),
                reviewedBy: req.user.id,
                result: req.body?.result,
                comment: req.body?.comment,
            });

            res.status(200).json({
                success: true,
                message: 'Revisión guardada correctamente.',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.user?.id) {
                throw new UnauthorizedError('Debes iniciar sesión para resolver solicitudes.');
            }

            const data = await adminSupplierApplicationService.resolveApplication({
                applicationId: getParam(req.params.id),
                reviewedBy: req.user.id,
                state: req.body?.state,
                comments: req.body?.comments,
            });

            res.status(200).json({
                success: true,
                message: 'Solicitud resuelta correctamente.',
                data,
            });
        } catch (error) {
            next(error);
        }
    }
}

export const adminSupplierApplicationController = new AdminSupplierApplicationController();
