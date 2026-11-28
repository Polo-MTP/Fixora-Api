import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { branches_categories, categories, employees } from '../database/schema/tables.ts';
import type { MatchingCandidate } from '../types/matching.types.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import { rankCandidates } from './matching.service.ts';
import {
  parseRecommendationsQuery,
  pickRecommendations,
  type RecommendationsQuery,
} from './recommendations.rules.ts';
import { searchService } from './search.service.ts';

/** Cuántas sucursales cercanas se consideran (las más cercanas primero). */
const NEARBY_BRANCHES = 50;

/**
 * API-47: servicios recomendados para la pantalla principal del cliente. Califica cada pareja
 * sucursal-servicio con el algoritmo de emparejamiento (API-24): cercanía, técnico independiente,
 * disponibilidad, calificación y precio de ese servicio. A diferencia de la búsqueda, la
 * disponibilidad usa si hay técnicos en línea ahora (Redis), no solo el horario.
 */

/** Sucursales con al menos un técnico en línea. Si Redis falla, ninguna cuenta como en línea. */
async function branchesOnline(branchIds: bigint[]): Promise<Set<string>> {
  const online = new Set<string>();
  if (!branchIds.length || !redis.isOpen) return online;
  const staff = await db
    .select({ id: employees.UniqueID, branchId: employees.branch_id })
    .from(employees)
    .where(
      and(
        inArray(employees.branch_id, branchIds),
        eq(employees.active, true),
        eq(employees.can_attend, true),
      ),
    );
  await Promise.all(
    staff.map(async (employee) => {
      try {
        if (await redis.get(redisKeys.technicianOnline(employee.id))) {
          online.add(employee.branchId.toString());
        }
      } catch {
        // Sin Redis no se sabe quién está en línea; se recomienda igual por horario.
      }
    }),
  );
  return online;
}

/** GET /api/search/recommendations */
export async function getRecommendations(query: RecommendationsQuery) {
  const { lat, lng, radiusKm, limit } = parseRecommendationsQuery(query);
  const nearby = await searchService.searchBranches({
    lat,
    lng,
    radius_km: radiusKm,
    sort: 'distancia',
    limit: NEARBY_BRANCHES,
  });
  if (!nearby.data.length) return { data: [] };

  const branchIds = nearby.data.map((branch) => BigInt(branch.id));
  const services = await db
    .select({
      branchId: branches_categories.branch_id,
      categoryId: categories.UniqueID,
      categoryName: categories.name,
      iconKey: categories.icon_key,
      basePrice: branches_categories.base_price,
      duration: branches_categories.duration_minutes,
    })
    .from(branches_categories)
    .innerJoin(categories, eq(categories.UniqueID, branches_categories.category_id))
    .where(
      and(
        inArray(branches_categories.branch_id, branchIds),
        eq(branches_categories.active, true),
        eq(categories.active, true),
      ),
    );
  const online = await branchesOnline(branchIds);
  const branchById = new Map(nearby.data.map((branch) => [branch.id, branch]));

  const candidates: MatchingCandidate[] = services.map((service) => {
    const branch = branchById.get(service.branchId.toString())!;
    return {
      id: `${branch.id}:${service.categoryId}`,
      name: branch.name,
      business_name: branch.business_name,
      supplier_type: branch.supplier_type,
      latitude: branch.latitude,
      longitude: branch.longitude,
      distance_km: branch.distance_km,
      open_now: branch.open_now,
      is_online_in_redis: online.has(branch.id),
      rating_avg: branch.rating_avg,
      reviews_count: branch.reviews_count,
      base_price: service.basePrice,
    };
  });
  const serviceById = new Map(
    services.map((service) => [`${service.branchId}:${service.categoryId}`, service]),
  );

  const ranked = rankCandidates(candidates, radiusKm).map((candidate) => {
    const service = serviceById.get(candidate.id)!;
    return {
      branchId: service.branchId.toString(),
      categoryId: service.categoryId.toString(),
      matchScore: candidate.match_score,
      service,
    };
  });

  return {
    data: pickRecommendations(ranked, limit).map((pair) => {
      const branch = branchById.get(pair.branchId)!;
      return {
        branch: {
          id: branch.id,
          name: branch.name,
          business_name: branch.business_name,
          supplier_type: branch.supplier_type,
          logo_url: branch.logo_url,
          latitude: branch.latitude,
          longitude: branch.longitude,
          distance_km: Math.round(branch.distance_km * 10) / 10,
          rating_avg: branch.rating_avg,
          reviews_count: branch.reviews_count,
        },
        category: {
          id: pair.categoryId,
          name: pair.service.categoryName,
          icon_key: pair.service.iconKey,
        },
        base_price: Number(pair.service.basePrice).toFixed(2),
        duration_minutes: pair.service.duration,
        open_now: branch.open_now,
        online_now: online.has(branch.id),
        match_score: pair.matchScore,
      };
    }),
  };
}
