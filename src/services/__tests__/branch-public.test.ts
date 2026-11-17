import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { closeDatabase } from '../../config/database.ts';
import { branchPublicController } from '../../controllers/branch-public.controller.ts';
import { branchPublicService } from '../branch-public.service.ts';
import { NotFoundError } from '../../errors/app-error.ts';
import type { BranchPublicProfileResponse } from '../../types/portfolio.types.ts';

describe('API-21: Ficha Pública del Proveedor', () => {
  describe('Controlador de Ficha Pública (branchPublicController)', () => {
    it('es un endpoint público accesible sin token de autenticación (req.user no requerido)', async () => {
      // Mock de sucursal ficticia devuelta por el servicio
      const mockProfile: BranchPublicProfileResponse = {
        id: '1',
        name: 'Sucursal Matriz',
        business_name: 'Plomería y Gas Los Hermanos',
        supplier_type: 'independiente',
        description: 'Especialistas en instalaciones hidrosanitarias residenciales.',
        logo_url: 'https://cdn.fixora.app/photos/1/avatar.jpg',
        phone: '5512345678',
        is_verified: true,
        plates: ['ABC-1234', 'XYZ-5678'],
        rating_avg: 4.8,
        reviews_count: 12,
        total_jobs: 35,
        accepting_request: true,
        location: {
          colony: 'Del Valle',
          municipality: 'Benito Juárez',
          latitude: 19.3821,
          longitude: -99.1678,
        },
        schedules: [
          { day_of_week: 1, open_time: '08:00', close_time: '18:00', active: true },
          { day_of_week: 2, open_time: '08:00', close_time: '18:00', active: true },
        ],
        categories: [
          {
            category_id: '1',
            category_name: 'Plomería',
            icon_key: 'icons/plomeria.png',
            base_price: '250.00',
            duration_minutes: 60,
          },
        ],
        portfolio: [],
        certificates: [
          {
            id: '10',
            type_name: 'Certificación DC-3 Plomería',
            file_key: 'docs/cert.pdf',
            url: 'https://cdn.fixora.app/docs/cert.pdf',
          },
        ],
        latest_reviews: [
          { rating: 5, comment: 'Excelente trabajo y muy puntual.', author_name: 'Roberto M.' },
        ],
      };

      const originalMethod = branchPublicService.getBranchPublicProfile;
      branchPublicService.getBranchPublicProfile = async () => mockProfile;

      try {
        let statusCode: number | null = null;
        let jsonResponse: unknown = null;

        const req = {
          params: { id: '1' },
          // Nota: req.user es undefined intencionalmente
        } as unknown as Request;

        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: unknown) => {
            jsonResponse = body;
            return res;
          },
        } as unknown as Response;

        const next: NextFunction = () => {};

        await branchPublicController.getBranchPublicProfile(req, res, next);

        assert.equal(statusCode, 200);
        assert.ok(jsonResponse && typeof jsonResponse === 'object');
        const typedResponse = jsonResponse as {
          success: boolean;
          message: string;
          data: BranchPublicProfileResponse;
        };

        assert.equal(typedResponse.success, true);
        assert.equal(typedResponse.data.id, '1');
        assert.equal(typedResponse.data.is_verified, true);
        assert.deepEqual(typedResponse.data.plates, ['ABC-1234', 'XYZ-5678']);
        assert.equal(typedResponse.data.rating_avg, 4.8);
        assert.equal(typedResponse.data.reviews_count, 12);
        assert.equal(typedResponse.data.location.colony, 'Del Valle');
        // Confirma que no se expone dirección exacta
        assert.equal(
          (typedResponse.data.location as unknown as Record<string, unknown>).street,
          undefined,
        );
      } finally {
        branchPublicService.getBranchPublicProfile = originalMethod;
      }
    });

    it('devuelve rating_avg en 0 y reviews_count en 0 cuando no hay reseñas registradas', async () => {
      const mockProfileZeroReviews: BranchPublicProfileResponse = {
        id: '2',
        name: 'Técnico Electricista',
        business_name: 'Electricidad Ramírez',
        supplier_type: 'independiente',
        description: null,
        logo_url: null,
        phone: '5598765432',
        is_verified: false,
        plates: [],
        rating_avg: 0,
        reviews_count: 0,
        total_jobs: 0,
        accepting_request: true,
        location: {
          colony: 'Roma Norte',
          municipality: 'Cuauhtémoc',
          latitude: 19.418,
          longitude: -99.162,
        },
        schedules: [],
        categories: [],
        portfolio: [],
        certificates: [],
        latest_reviews: [],
      };

      const originalMethod = branchPublicService.getBranchPublicProfile;
      branchPublicService.getBranchPublicProfile = async () => mockProfileZeroReviews;

      try {
        let statusCode: number | null = null;
        let jsonResponse: unknown = null;

        const req = {
          params: { id: '2' },
        } as unknown as Request;

        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: unknown) => {
            jsonResponse = body;
            return res;
          },
        } as unknown as Response;

        const next: NextFunction = () => {};

        await branchPublicController.getBranchPublicProfile(req, res, next);

        assert.equal(statusCode, 200);
        const typedResponse = jsonResponse as {
          data: BranchPublicProfileResponse;
        };
        assert.equal(typedResponse.data.rating_avg, 0);
        assert.equal(typedResponse.data.reviews_count, 0);
        assert.deepEqual(typedResponse.data.latest_reviews, []);
        assert.deepEqual(typedResponse.data.plates, []);
        assert.equal(typedResponse.data.is_verified, false);
      } finally {
        branchPublicService.getBranchPublicProfile = originalMethod;
      }
    });

    it('propaga error a next() si la sucursal no existe', async () => {
      const originalMethod = branchPublicService.getBranchPublicProfile;
      branchPublicService.getBranchPublicProfile = async () => {
        throw new NotFoundError('Sucursal no encontrada.');
      };

      try {
        const req = {
          params: { id: '999999' },
        } as unknown as Request;
        const res = { status: () => res, json: () => res } as unknown as Response;
        let errorPassed: unknown = null;
        const next: NextFunction = (err?: unknown) => {
          errorPassed = err;
        };

        await branchPublicController.getBranchPublicProfile(req, res, next);

        assert.ok(errorPassed instanceof NotFoundError);
        assert.equal((errorPassed as NotFoundError).statusCode, 404);
        assert.equal((errorPassed as NotFoundError).message, 'Sucursal no encontrada.');
      } finally {
        branchPublicService.getBranchPublicProfile = originalMethod;
      }
    });
  });

  after(async () => {
    await closeDatabase();
  });
});
