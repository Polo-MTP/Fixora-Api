import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMENDATIONS,
  parseRecommendationsQuery,
  pickRecommendations,
} from '../recommendations.rules.ts';
import { BadRequestError } from '../../errors/app-error.ts';

const pair = (branchId: string, categoryId: string, matchScore: number) => ({
  branchId,
  categoryId,
  matchScore,
});

describe('API-47: servicios recomendados', () => {
  it('no repite negocio aunque tenga varios servicios bien calificados', () => {
    const ranked = [
      pair('1', 'plomeria', 90),
      pair('1', 'electricidad', 89),
      pair('2', 'pintura', 70),
    ];

    const picked = pickRecommendations(ranked, 8);

    assert.deepEqual(
      picked.map((p) => `${p.branchId}:${p.categoryId}`),
      ['1:plomeria', '2:pintura'],
    );
  });

  it('primero varía los servicios: no son ocho plomeros', () => {
    const ranked = [
      pair('1', 'plomeria', 95),
      pair('2', 'plomeria', 94),
      pair('3', 'plomeria', 93),
      pair('4', 'electricidad', 60),
    ];

    const picked = pickRecommendations(ranked, 2);

    assert.deepEqual(
      picked.map((p) => p.branchId),
      ['1', '4'],
    );
  });

  it('si faltan, completa con los mejores aunque repitan servicio, en el orden del emparejamiento', () => {
    const ranked = [
      pair('1', 'plomeria', 95),
      pair('2', 'plomeria', 94),
      pair('3', 'electricidad', 60),
      pair('4', 'plomeria', 50),
    ];

    const picked = pickRecommendations(ranked, 3);

    assert.deepEqual(
      picked.map((p) => p.branchId),
      ['1', '2', '3'],
    );
  });

  it('sin candidatos no recomienda nada', () => {
    assert.deepEqual(pickRecommendations([], 8), []);
  });

  it('pide las coordenadas del cliente; radio y cuántos tienen límite', () => {
    assert.deepEqual(parseRecommendationsQuery({ lat: '25.54', lng: '-103.41' }), {
      lat: 25.54,
      lng: -103.41,
      radiusKm: 10,
      limit: DEFAULT_RECOMMENDATIONS,
    });
    for (const query of [
      {},
      { lat: '25.54' },
      { lat: '100', lng: '-103.41' },
      { lat: '25.54', lng: '-103.41', radius_km: '0' },
      { lat: '25.54', lng: '-103.41', limit: '21' },
      { lat: '25.54', lng: '-103.41', limit: '2.5' },
    ]) {
      assert.throws(() => parseRecommendationsQuery(query), BadRequestError, JSON.stringify(query));
    }
  });
});
