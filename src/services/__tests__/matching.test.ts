import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { calculateCandidateScore, rankCandidates, matchingService } from '../matching.service.ts';
import type { MatchingCandidate } from '../../types/matching.types.ts';
import type { BranchSearchResultItem } from '../../types/search.types.ts';

describe('API-24: Algoritmo de Emparejamiento', () => {
  describe('Cálculo de Desglose y Puntuación (calculateCandidateScore)', () => {
    it('otorga bonificación máxima de 100 a técnicos independientes y 50 a empresas', () => {
      const independent: MatchingCandidate = {
        id: '1',
        name: 'Carlos Pérez',
        business_name: 'Plomería Carlos',
        supplier_type: 'independiente',
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 2.0,
        open_now: true,
        is_online_in_redis: true,
        rating_avg: 4.8,
        reviews_count: 15,
        base_price: '250.00',
      };

      const company: MatchingCandidate = {
        ...independent,
        id: '2',
        supplier_type: 'empresa',
        business_name: 'Grupo Multiservicios S.A.',
      };

      const scoreInd = calculateCandidateScore(independent, 10);
      const scoreComp = calculateCandidateScore(company, 10);

      assert.equal(scoreInd.independent_bonus, 100);
      assert.equal(scoreComp.independent_bonus, 50);
      // Con las mismas características, el independiente siempre tiene mayor puntuación total
      assert.ok(scoreInd.total_score > scoreComp.total_score);
      // La diferencia exacta corresponde al 30% del peso sobre los 50 pts de diferencia: 15 pts
      assert.equal(Math.round((scoreInd.total_score - scoreComp.total_score) * 10) / 10, 15);
    });

    it('evalúa la cercanía de forma proporcional (a menor distancia, mayor puntaje)', () => {
      const candidateAt0km: MatchingCandidate = {
        id: '1',
        name: 'Técnico 1',
        business_name: 'Fix 1',
        supplier_type: 'independiente',
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 0,
        open_now: true,
        rating_avg: 5.0,
        reviews_count: 10,
        base_price: '200.00',
      };

      const candidateAt5km: MatchingCandidate = {
        ...candidateAt0km,
        distance_km: 5.0,
      };

      const candidateAt10km: MatchingCandidate = {
        ...candidateAt0km,
        distance_km: 10.0,
      };

      const score0 = calculateCandidateScore(candidateAt0km, 10);
      const score5 = calculateCandidateScore(candidateAt5km, 10);
      const score10 = calculateCandidateScore(candidateAt10km, 10);

      assert.equal(score0.proximity_score, 100);
      assert.equal(score5.proximity_score, 50);
      assert.equal(score10.proximity_score, 0);
    });

    it('evalúa la disponibilidad real: Redis (100) > Abierto (75) > Cerrado (10)', () => {
      const base: MatchingCandidate = {
        id: '1',
        name: 'Técnico',
        business_name: 'Taller',
        supplier_type: 'independiente',
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 1.0,
        open_now: false,
        is_online_in_redis: false,
        rating_avg: 4.5,
        reviews_count: 5,
        base_price: '300.00',
      };

      const closed = calculateCandidateScore({
        ...base,
        open_now: false,
        is_online_in_redis: false,
      });
      const openSchedule = calculateCandidateScore({
        ...base,
        open_now: true,
        is_online_in_redis: false,
      });
      const onlineRedis = calculateCandidateScore({
        ...base,
        open_now: true,
        is_online_in_redis: true,
      });

      assert.equal(closed.availability_score, 10);
      assert.equal(openSchedule.availability_score, 75);
      assert.equal(onlineRedis.availability_score, 100);

      assert.ok(onlineRedis.total_score > openSchedule.total_score);
      assert.ok(openSchedule.total_score > closed.total_score);
    });

    it('asigna 70 puntos neutros de calificación a técnicos nuevos sin reseñas', () => {
      const newTech: MatchingCandidate = {
        id: '1',
        name: 'Nuevo Técnico',
        business_name: 'Fixora Express',
        supplier_type: 'independiente',
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 2.0,
        open_now: true,
        rating_avg: 0,
        reviews_count: 0,
        base_price: '200.00',
      };

      const topTech: MatchingCandidate = {
        ...newTech,
        rating_avg: 5.0,
        reviews_count: 30,
      };

      const scoreNew = calculateCandidateScore(newTech, 10);
      const scoreTop = calculateCandidateScore(topTech, 10);

      assert.equal(scoreNew.rating_score, 70); // 70 puntos base neutrales
      assert.equal(scoreTop.rating_score, 100);
      assert.ok(scoreTop.total_score > scoreNew.total_score);
    });

    it('evalúa el precio base favoreciendo cotizaciones accesibles', () => {
      const candidateCheap: MatchingCandidate = {
        id: '1',
        name: 'Técnico Económico',
        business_name: 'Econofix',
        supplier_type: 'independiente',
        latitude: 19.43,
        longitude: -99.13,
        distance_km: 2.0,
        open_now: true,
        rating_avg: 4.5,
        reviews_count: 10,
        base_price: '150.00',
      };

      const candidateExpensive: MatchingCandidate = {
        ...candidateCheap,
        base_price: '900.00',
      };

      const candidateNoPrice: MatchingCandidate = {
        ...candidateCheap,
        base_price: null,
      };

      const scoreCheap = calculateCandidateScore(candidateCheap, 10, 150, 800);
      const scoreExp = calculateCandidateScore(candidateExpensive, 10, 150, 800);
      const scoreNull = calculateCandidateScore(candidateNoPrice, 10, 150, 800);

      assert.equal(scoreCheap.price_score, 100);
      assert.equal(scoreExp.price_score, 20);
      assert.equal(scoreNull.price_score, 70); // Neutro
    });
  });

  describe('Ordenamiento de Candidatos (rankCandidates)', () => {
    it('prioriza a técnicos independientes cercanos sobre empresas lejanas', () => {
      const candidates: MatchingCandidate[] = [
        {
          id: 'empresa-lejana',
          name: 'Gran Empresa S.A.',
          business_name: 'Empresa Gigante',
          supplier_type: 'empresa',
          latitude: 19.45,
          longitude: -99.1,
          distance_km: 7.5,
          open_now: true,
          rating_avg: 4.9,
          reviews_count: 100,
          base_price: '500.00',
        },
        {
          id: 'independiente-cercano',
          name: 'Roberto Gómez',
          business_name: 'Plomería Gómez',
          supplier_type: 'independiente',
          latitude: 19.43,
          longitude: -99.13,
          distance_km: 1.5,
          open_now: true,
          rating_avg: 4.7,
          reviews_count: 12,
          base_price: '250.00',
        },
      ];

      const ranked = rankCandidates(candidates, 10);

      assert.equal(ranked[0].id, 'independiente-cercano');
      assert.equal(ranked[1].id, 'empresa-lejana');
      assert.ok(ranked[0].match_score > ranked[1].match_score);
    });

    it('desempata por menor distancia cuando las puntuaciones son idénticas', () => {
      const candidates: MatchingCandidate[] = [
        {
          id: 'candidato-b',
          name: 'Técnico B',
          business_name: 'Fix B',
          supplier_type: 'independiente',
          latitude: 19.44,
          longitude: -99.12,
          distance_km: 3.0,
          open_now: true,
          rating_avg: 5.0,
          reviews_count: 10,
          base_price: '300.00',
        },
        {
          id: 'candidato-a',
          name: 'Técnico A',
          business_name: 'Fix A',
          supplier_type: 'independiente',
          latitude: 19.43,
          longitude: -99.13,
          distance_km: 2.0,
          open_now: true,
          rating_avg: 5.0,
          reviews_count: 10,
          base_price: '300.00',
        },
      ];

      const ranked = rankCandidates(candidates, 10);

      // Candidato A está más cerca (2.0 km vs 3.0 km)
      assert.equal(ranked[0].id, 'candidato-a');
      assert.equal(ranked[1].id, 'candidato-b');
    });
  });

  describe('Integración con Búsqueda de Sucursales (rankBranchesForSearch)', () => {
    it('ordena la lista de sucursales devuelta por la búsqueda aplicando el algoritmo de matching', () => {
      const searchItems: BranchSearchResultItem[] = [
        {
          id: '10',
          name: 'Franquicia Plomeros S.A.',
          business_name: 'Franquicia',
          supplier_type: 'empresa',
          logo_url: null,
          latitude: 19.45,
          longitude: -99.1,
          distance_km: 5.0,
          rating_avg: 4.5,
          reviews_count: 20,
          base_price: '400.00',
          open_now: true,
        },
        {
          id: '20',
          name: 'Pedro Cerrajero',
          business_name: 'Cerrajería Rápida',
          supplier_type: 'independiente',
          logo_url: null,
          latitude: 19.43,
          longitude: -99.13,
          distance_km: 1.8,
          rating_avg: 4.8,
          reviews_count: 15,
          base_price: '200.00',
          open_now: true,
        },
        {
          id: '30',
          name: 'Taller Cerrado',
          business_name: 'Taller X',
          supplier_type: 'independiente',
          logo_url: null,
          latitude: 19.43,
          longitude: -99.13,
          distance_km: 1.0,
          rating_avg: 4.0,
          reviews_count: 2,
          base_price: '180.00',
          open_now: false, // Cerrado
        },
      ];

      const ranked = matchingService.rankBranchesForSearch(searchItems, 10);

      assert.equal(ranked.length, 3);
      // El independiente abierto y cercano (20) debe estar en primer lugar
      assert.equal(ranked[0].id, '20');
      // La sucursal cerrada (30) queda penalizada en disponibilidad y va después de los abiertos
      assert.equal(ranked[2].id, '30');
    });
  });

  describe('Botón de Emergencia (findAndRankEmergencyTechnicians)', () => {
    it('devuelve lista vacía cuando no hay técnicos activos en Redis dentro del radio', async () => {
      const result = await matchingService.findAndRankEmergencyTechnicians({
        clientLat: 19.4326,
        clientLng: -99.1332,
        radiusKm: 10,
      });

      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });

    it('maneja de forma segura radios personalizados y categorías inexistentes', async () => {
      const result = await matchingService.findAndRankEmergencyTechnicians({
        clientLat: 19.4326,
        clientLng: -99.1332,
        radiusKm: 25,
        categoryId: '999999999',
      });

      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    });
  });
});
