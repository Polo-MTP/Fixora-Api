import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { closeDatabase } from '../../config/database.ts';
import {
  calculateHaversineDistanceKm,
  sortSearchResults,
  searchService,
} from '../search.service.ts';
import { searchController } from '../../controllers/search.controller.ts';
import { BadRequestError } from '../../errors/app-error.ts';
import type { BranchSearchResultItem } from '../../types/search.types.ts';

describe('API-23: Búsqueda de Proveedores por Radio, Categoría y Filtros', () => {
  describe('Cálculo de Distancia Haversine (calculateHaversineDistanceKm)', () => {
    it('distancia entre el mismo punto es 0 km', () => {
      const dist = calculateHaversineDistanceKm(19.4326, -99.1332, 19.4326, -99.1332);
      assert.equal(dist, 0);
    });

    it('calcula distancia realista en CDMX (Zócalo al Ángel de la Independencia)', () => {
      // Zócalo: 19.4326, -99.1332
      // Ángel: 19.4270, -99.1677
      const dist = calculateHaversineDistanceKm(19.4326, -99.1332, 19.427, -99.1677);
      // La distancia en línea recta es aprox ~3.7 km
      assert.ok(dist >= 3.5 && dist <= 4.0, `Distancia calculada: ${dist}`);
    });
  });

  describe('Algoritmos de Ordenamiento (sortSearchResults)', () => {
    const sampleItems: BranchSearchResultItem[] = [
      {
        id: '1',
        name: 'Plomería Centro',
        business_name: 'Plomería Centro S.A.',
        supplier_type: 'empresa',
        logo_url: null,
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 4.5,
        rating_avg: 4.9,
        reviews_count: 20,
        base_price: '300.00',
        open_now: true,
      },
      {
        id: '2',
        name: 'Técnico Juan',
        business_name: 'Juan Pérez Plomero',
        supplier_type: 'independiente',
        logo_url: null,
        latitude: 19.42,
        longitude: -99.14,
        distance_km: 2.1,
        rating_avg: 4.7,
        reviews_count: 10,
        base_price: '200.00',
        open_now: true,
      },
      {
        id: '3',
        name: 'Plomería Exprés',
        business_name: 'Plomería Exprés',
        supplier_type: 'empresa',
        logo_url: null,
        latitude: 19.41,
        longitude: -99.15,
        distance_km: 1.2,
        rating_avg: 4.2,
        reviews_count: 5,
        base_price: '250.00',
        open_now: false, // Cerrada
      },
      {
        id: '4',
        name: 'Servicios Generales',
        business_name: 'Multiservicios',
        supplier_type: 'independiente',
        logo_url: null,
        latitude: 19.4,
        longitude: -99.16,
        distance_km: 3.0,
        rating_avg: 5.0,
        reviews_count: 50,
        base_price: null, // Sin precio de categoría
        open_now: true,
      },
    ];

    it('ordena por distancia ascendente', () => {
      const sorted = sortSearchResults(sampleItems, 'distancia');
      assert.equal(sorted[0].id, '3'); // 1.2 km
      assert.equal(sorted[1].id, '2'); // 2.1 km
      assert.equal(sorted[2].id, '4'); // 3.0 km
      assert.equal(sorted[3].id, '1'); // 4.5 km
    });

    it('ordena por calificacion descendente', () => {
      const sorted = sortSearchResults(sampleItems, 'calificacion');
      assert.equal(sorted[0].id, '4'); // 5.0
      assert.equal(sorted[1].id, '1'); // 4.9
      assert.equal(sorted[2].id, '2'); // 4.7
      assert.equal(sorted[3].id, '3'); // 4.2
    });

    it('ordena por precio ascendente colocando precios null al final', () => {
      const sorted = sortSearchResults(sampleItems, 'precio');
      assert.equal(sorted[0].id, '2'); // 200.00
      assert.equal(sorted[1].id, '3'); // 250.00
      assert.equal(sorted[2].id, '1'); // 300.00
      assert.equal(sorted[3].id, '4'); // null
    });

    it('ordena por recomendado priorizando abiertos e independientes', () => {
      const sorted = sortSearchResults(sampleItems, 'recomendado');
      // Todos los abiertos van antes que el cerrado (id: 3)
      assert.equal(sorted[3].id, '3'); // cerrado va al final
      // Entre los abiertos, el técnico independiente cercano con buen rating (id: 2 o 4) tiene alta prioridad
      assert.equal(sorted[0].open_now, true);
      assert.equal(sorted[1].open_now, true);
      assert.equal(sorted[2].open_now, true);
    });
  });

  describe('Validaciones de Entrada (searchService)', () => {
    it('rechaza si falta latitud o no es un número', async () => {
      await assert.rejects(
        async () => {
          await searchService.searchBranches({
            lat: NaN,
            lng: -99.1332,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match((err as BadRequestError).message, /lat es obligatorio/);
          return true;
        },
      );
    });

    it('rechaza si latitud está fuera de rango (-90 a 90)', async () => {
      await assert.rejects(
        async () => {
          await searchService.searchBranches({
            lat: 95.0,
            lng: -99.1332,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match(
            (err as BadRequestError).message,
            /lat es obligatorio y debe estar entre -90 y 90/,
          );
          return true;
        },
      );
    });

    it('rechaza si longitud está fuera de rango (-180 a 180)', async () => {
      await assert.rejects(
        async () => {
          await searchService.searchBranches({
            lat: 19.43,
            lng: -190,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match(
            (err as BadRequestError).message,
            /lng es obligatorio y debe estar entre -180 y 180/,
          );
          return true;
        },
      );
    });

    it('rechaza si radius_km está fuera de rango (1 a 50 km)', async () => {
      await assert.rejects(
        async () => {
          await searchService.searchBranches({
            lat: 19.43,
            lng: -99.13,
            radius_km: 75,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match(
            (err as BadRequestError).message,
            /radius_km debe ser un número entre 1 y 50/,
          );
          return true;
        },
      );
    });

    it('rechaza criterio de ordenamiento desconocido', async () => {
      await assert.rejects(
        async () => {
          await searchService.searchBranches({
            lat: 19.43,
            lng: -99.13,
            // @ts-expect-error probando valor inválido
            sort: 'invalido',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof BadRequestError);
          assert.match((err as BadRequestError).message, /parámetro sort debe ser uno de/);
          return true;
        },
      );
    });
  });

  describe('Controlador HTTP de Búsqueda (searchController)', () => {
    it('responde 200 con resultados y paginación llamando a searchService', async () => {
      const mockResult = {
        data: [
          {
            id: '1',
            name: 'Plomería Roma',
            business_name: 'Plomería Roma S.A.',
            supplier_type: 'empresa' as const,
            logo_url: null,
            latitude: 19.41,
            longitude: -99.16,
            distance_km: 1.5,
            rating_avg: 4.8,
            reviews_count: 15,
            base_price: '280.00',
            open_now: true,
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
          total_pages: 1,
        },
      };

      const originalMethod = searchService.searchBranches;
      searchService.searchBranches = async () => mockResult;

      try {
        let statusCode: number | null = null;
        let responseBody: unknown = null;

        const req = {
          query: {
            lat: '19.41',
            lng: '-99.16',
            radius_km: '10',
            sort: 'distancia',
          },
        } as unknown as Request;

        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: unknown) => {
            responseBody = body;
            return res;
          },
        } as unknown as Response;

        const next: NextFunction = () => {};

        await searchController.searchBranches(req, res, next);

        assert.equal(statusCode, 200);
        const typed = responseBody as {
          success: boolean;
          data: BranchSearchResultItem[];
          pagination: { total: number };
        };
        assert.equal(typed.success, true);
        assert.equal(typed.data.length, 1);
        assert.equal(typed.data[0].id, '1');
        assert.equal(typed.pagination.total, 1);
      } finally {
        searchService.searchBranches = originalMethod;
      }
    });

    it('propaga error a next() si searchService lanza BadRequestError', async () => {
      const originalMethod = searchService.searchBranches;
      searchService.searchBranches = async () => {
        throw new BadRequestError('El parámetro lat es obligatorio y debe estar entre -90 y 90.');
      };

      try {
        const req = {
          query: { lat: 'invalido', lng: '-99.13' },
        } as unknown as Request;
        const res = { status: () => res, json: () => res } as unknown as Response;
        let errorCaught: unknown = null;
        const next: NextFunction = (err?: unknown) => {
          errorCaught = err;
        };

        await searchController.searchBranches(req, res, next);

        assert.ok(errorCaught instanceof BadRequestError);
        assert.equal((errorCaught as BadRequestError).statusCode, 400);
      } finally {
        searchService.searchBranches = originalMethod;
      }
    });
  });

  after(async () => {
    await closeDatabase();
  });
});
