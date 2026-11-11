import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { redis } from '../config/redis.ts';
import { redisKeys } from '../utils/redis-keys.ts';
import {
  branches,
  branches_categories,
  business,
  business_supplier,
  employees,
  personal_data,
  reviews,
  supplier_applications,
  suppliers,
} from '../database/schema/tables.ts';
import { calculateHaversineDistanceKm } from '../utils/geo.utils.ts';
import type {
  EmergencyTechnicianCandidate,
  MatchingCandidate,
  MatchingOptions,
  MatchingScoreBreakdown,
  RankedMatchingCandidate,
} from '../types/matching.types.ts';
import type { BranchSearchResultItem } from '../types/search.types.ts';

// Ponderaciones oficiales del Algoritmo de Emparejamiento (API-24)
const WEIGHT_PROXIMITY = 0.35; // 35% Cercanía al cliente
const WEIGHT_INDEPENDENT = 0.3; // 30% Prioridad a técnicos independientes
const WEIGHT_AVAILABILITY = 0.2; // 20% Disponibilidad real en tiempo real
const WEIGHT_RATING = 0.1; // 10% Calificación y confianza de usuarios
const WEIGHT_PRICE = 0.05; // 5% Cotización (precio base)

/**
 * Calcula el desglose y la puntuación de emparejamiento (0 a 100) para un candidato.
 * Función pura y determinista.
 */
export function calculateCandidateScore(
  candidate: MatchingCandidate,
  maxRadiusKm = 10,
  minReferencePrice = 150,
  maxReferencePrice = 800,
): MatchingScoreBreakdown {
  // 1. Puntuación de cercanía (a menor distancia, mayor puntaje)
  const effectiveDistance = Math.max(0, candidate.distance_km);
  const proximityRatio = Math.max(0, 1 - effectiveDistance / maxRadiusKm);
  const proximityScore = Math.round(proximityRatio * 100);

  // 2. Bonificación de prioridad a técnicos independientes
  // Los técnicos independientes reciben la máxima bonificación (100 pts)
  // Las empresas con múltiples sucursales reciben 50 pts
  const independentBonus = candidate.supplier_type === 'independiente' ? 100 : 50;

  // 3. Puntuación de disponibilidad real
  let availabilityScore = 10; // Base por defecto si está cerrado
  if (candidate.is_online_in_redis) {
    availabilityScore = 100; // Activo en Redis en tiempo real
  } else if (candidate.open_now) {
    availabilityScore = 75; // Sucursal abierta y en horario de atención
  }

  // 4. Puntuación de calificación y confianza
  let ratingScore = 70; // 70 pts por defecto para técnicos nuevos sin reseñas (3.5 estrellas equivalentes)
  if (candidate.reviews_count > 0) {
    const normalizedRating = Math.max(1, Math.min(5, candidate.rating_avg));
    ratingScore = Math.round((normalizedRating / 5.0) * 100);
  }

  // 5. Puntuación de cotización (precio base de la categoría)
  let priceScore = 70; // Neutro si no viene precio
  if (candidate.base_price !== null) {
    const price = Number(candidate.base_price);
    if (!isNaN(price) && price > 0) {
      if (price <= minReferencePrice) {
        priceScore = 100;
      } else if (price >= maxReferencePrice) {
        priceScore = 20;
      } else {
        const ratio = (price - minReferencePrice) / (maxReferencePrice - minReferencePrice);
        priceScore = Math.round((1 - ratio * 0.8) * 100);
      }
    }
  }

  // Puntuación global ponderada (0 a 100)
  const rawTotal =
    proximityScore * WEIGHT_PROXIMITY +
    independentBonus * WEIGHT_INDEPENDENT +
    availabilityScore * WEIGHT_AVAILABILITY +
    ratingScore * WEIGHT_RATING +
    priceScore * WEIGHT_PRICE;

  const totalScore = Math.round(rawTotal * 10) / 10;

  return {
    proximity_score: proximityScore,
    independent_bonus: independentBonus,
    availability_score: availabilityScore,
    rating_score: ratingScore,
    price_score: priceScore,
    total_score: totalScore,
  };
}

/**
 * Ordena candidatos de mayor a menor puntuación de emparejamiento.
 */
export function rankCandidates(
  candidates: MatchingCandidate[],
  maxRadiusKm = 10,
): RankedMatchingCandidate[] {
  const prices = candidates
    .map((c) => (c.base_price !== null ? Number(c.base_price) : NaN))
    .filter((p) => !isNaN(p) && p > 0);

  const minPrice = prices.length > 0 ? Math.min(...prices) : 150;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 800;

  const ranked: RankedMatchingCandidate[] = candidates.map((c) => {
    const breakdown = calculateCandidateScore(c, maxRadiusKm, minPrice, maxPrice);
    return {
      ...c,
      match_score: breakdown.total_score,
      breakdown,
    };
  });

  return ranked.sort((a, b) => {
    if (b.match_score !== a.match_score) {
      return b.match_score - a.match_score;
    }
    // Desempate: menor distancia
    return a.distance_km - b.distance_km;
  });
}

export class MatchingService {
  /**
   * Rankea sucursales para el ordenamiento 'recomendado' de la búsqueda (API-23).
   * Integra el algoritmo oficial de emparejamiento de API-24.
   */
  rankBranchesForSearch(items: BranchSearchResultItem[], radiusKm = 10): BranchSearchResultItem[] {
    const candidates: MatchingCandidate[] = items.map((item) => ({
      id: item.id,
      name: item.name,
      business_name: item.business_name,
      supplier_type: item.supplier_type,
      latitude: item.latitude,
      longitude: item.longitude,
      distance_km: item.distance_km,
      open_now: item.open_now,
      is_online_in_redis: false,
      rating_avg: item.rating_avg,
      reviews_count: item.reviews_count,
      base_price: item.base_price,
    }));

    const ranked = rankCandidates(candidates, radiusKm);

    // En búsqueda, los proveedores abiertos tienen prioridad absoluta de disponibilidad
    // sobre los cerrados; dentro de cada grupo se ordenan por su match_score y cercanía.
    const sortedByAvailabilityAndScore = [...ranked].sort((a, b) => {
      if (a.open_now !== b.open_now) {
        return a.open_now ? -1 : 1;
      }
      if (b.match_score !== a.match_score) {
        return b.match_score - a.match_score;
      }
      return a.distance_km - b.distance_km;
    });

    // Mapear de vuelta preservando los campos originales
    const itemMap = new Map(items.map((i) => [i.id, i]));
    return sortedByAvailabilityAndScore
      .map((r) => itemMap.get(r.id))
      .filter((i): i is BranchSearchResultItem => i !== undefined);
  }

  /**
   * Localiza y rankea los técnicos disponibles en tiempo real para el Botón de Emergencia (API-28).
   * Busca técnicos en Redis con marca activa `online: true`, valida que su sucursal acepte
   * emergencias y prioriza a los independientes más cercanos al cliente.
   */
  async findAndRankEmergencyTechnicians(
    options: MatchingOptions,
  ): Promise<EmergencyTechnicianCandidate[]> {
    const { clientLat, clientLng, radiusKm = 10, categoryId } = options;

    let categoryIdBigInt: bigint | null = null;
    if (categoryId) {
      try {
        categoryIdBigInt = BigInt(categoryId);
      } catch {
        // Ignorar si no es número válido
      }
    }

    // 1. Consultar técnicos en Redis que reportaron posición dentro del radio
    let nearbyEmployeeIds: string[];
    try {
      // Buscar miembros en el índice geoespacial de Redis
      const geoResults = await redis.geoSearch(
        redisKeys.technicianPositions(),
        { latitude: clientLat, longitude: clientLng },
        { radius: radiusKm, unit: 'km' },
        { SORT: 'ASC' },
      );
      nearbyEmployeeIds = geoResults;
    } catch {
      // Si Redis no está disponible o falla geoSearch, nearbyEmployeeIds queda vacío
      nearbyEmployeeIds = [];
    }

    if (nearbyEmployeeIds.length === 0) {
      return [];
    }

    const employeeBigIntIds = nearbyEmployeeIds
      .map((id) => {
        try {
          return BigInt(id);
        } catch {
          return null;
        }
      })
      .filter((id): id is bigint => id !== null);

    if (employeeBigIntIds.length === 0) {
      return [];
    }

    // 2. Consultar datos en PostgreSQL de los técnicos encontrados
    const employeeRows = await db
      .select({
        employeeId: employees.UniqueID,
        userId: employees.user_id,
        branchId: employees.branch_id,
        canAttend: employees.can_attend,
        employeeActive: employees.active,
        name: personal_data.name,
        lastnameP: personal_data.lastname_p,
        phone: personal_data.phone,
        branchName: branches.name,
        branchAccepting: branches.accepting_request,
        businessName: business.name,
        supplierType: suppliers.supplier_type,
        supplierId: suppliers.UniqueID,
      })
      .from(employees)
      .innerJoin(personal_data, eq(employees.user_id, personal_data.user_id))
      .innerJoin(branches, eq(employees.branch_id, branches.UniqueID))
      .innerJoin(business, eq(branches.business_id, business.UniqueID))
      .innerJoin(business_supplier, eq(business.UniqueID, business_supplier.business_id))
      .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
      .where(
        and(
          inArray(employees.UniqueID, employeeBigIntIds),
          eq(employees.active, true),
          eq(employees.can_attend, true),
          eq(branches.accepting_request, true),
          eq(suppliers.active, true),
        ),
      );

    if (employeeRows.length === 0) {
      return [];
    }

    // 3. Filtrar proveedores con solicitud aprobada (verificados)
    const supplierIds = Array.from(new Set(employeeRows.map((e) => e.supplierId)));
    const approvedApps = await db
      .select({ supplierId: supplier_applications.supplier_id })
      .from(supplier_applications)
      .where(
        and(
          inArray(supplier_applications.supplier_id, supplierIds),
          eq(supplier_applications.state, 'aprobada'),
        ),
      );

    const approvedSupplierSet = new Set(approvedApps.map((a) => a.supplierId.toString()));
    const validEmployees = employeeRows.filter((e) =>
      approvedSupplierSet.has(e.supplierId.toString()),
    );

    if (validEmployees.length === 0) {
      return [];
    }

    // 4. Si se especificó categoría, validar que la sucursal la ofrezca
    const branchIds = Array.from(new Set(validEmployees.map((e) => e.branchId)));
    const branchCategories = await db
      .select({
        branchId: branches_categories.branch_id,
        categoryId: branches_categories.category_id,
        basePrice: branches_categories.base_price,
      })
      .from(branches_categories)
      .where(
        and(
          inArray(branches_categories.branch_id, branchIds),
          eq(branches_categories.active, true),
        ),
      );

    // 5. Consultar reseñas para el cálculo de reputación
    const userIds = validEmployees.map((e) => e.userId);
    const techReviews = await db
      .select({
        revieweeId: reviews.reviewee_id,
        rating: reviews.rating,
      })
      .from(reviews)
      .where(and(inArray(reviews.reviewee_id, userIds), eq(reviews.status, 'publicada')));

    // 6. Obtener posiciones precisas desde Redis
    const candidates: EmergencyTechnicianCandidate[] = [];

    for (const emp of validEmployees) {
      // Validar categoría si aplica
      let basePrice: string | null = null;
      if (categoryIdBigInt !== null) {
        const cat = branchCategories.find(
          (c) => c.branchId === emp.branchId && c.categoryId === categoryIdBigInt,
        );
        if (!cat) continue; // No atiende la categoría solicitada
        basePrice = Number(cat.basePrice).toFixed(2);
      }

      // Obtener coordenadas de Redis
      let techLat = clientLat;
      let techLng = clientLng;
      try {
        const rawOnline = await redis.get(redisKeys.technicianOnline(emp.employeeId));
        if (rawOnline) {
          const parsed = JSON.parse(rawOnline) as { latitude?: number; longitude?: number };
          if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
            techLat = parsed.latitude;
            techLng = parsed.longitude;
          }
        }
      } catch {
        // En caso de fallo usar posición base
      }

      const distanceKm = calculateHaversineDistanceKm(clientLat, clientLng, techLat, techLng);
      if (distanceKm > radiusKm) continue;

      // Calcular calificación
      const empReviews = techReviews.filter((r) => r.revieweeId === emp.userId);
      const reviewsCount = empReviews.length;
      const ratingAvg =
        reviewsCount > 0
          ? Math.round((empReviews.reduce((sum, r) => sum + r.rating, 0) / reviewsCount) * 10) / 10
          : 0;

      const matchingCandidate: MatchingCandidate = {
        id: emp.employeeId.toString(),
        employee_id: emp.employeeId.toString(),
        name: `${emp.name} ${emp.lastnameP}`.trim(),
        business_name: emp.businessName,
        supplier_type: emp.supplierType,
        latitude: techLat,
        longitude: techLng,
        distance_km: distanceKm,
        open_now: true,
        is_online_in_redis: true,
        rating_avg: ratingAvg,
        reviews_count: reviewsCount,
        base_price: basePrice,
      };

      const breakdown = calculateCandidateScore(matchingCandidate, radiusKm);

      candidates.push({
        employee_id: emp.employeeId.toString(),
        user_id: emp.userId.toString(),
        branch_id: emp.branchId.toString(),
        name: `${emp.name} ${emp.lastnameP}`.trim(),
        business_name: emp.businessName,
        supplier_type: emp.supplierType,
        phone: emp.phone,
        latitude: techLat,
        longitude: techLng,
        distance_km: distanceKm,
        rating_avg: ratingAvg,
        reviews_count: reviewsCount,
        base_price: basePrice,
        match_score: breakdown.total_score,
        breakdown,
      });
    }

    // Ordenar de mayor a menor match_score (prioridad a independientes más cercanos)
    return candidates.sort((a, b) => {
      if (b.match_score !== a.match_score) {
        return b.match_score - a.match_score;
      }
      return a.distance_km - b.distance_km;
    });
  }
}

export const matchingService = new MatchingService();
