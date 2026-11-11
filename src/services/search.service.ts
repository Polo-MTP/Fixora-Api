import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  addresses,
  branches,
  branches_categories,
  branch_schedules,
  business,
  business_supplier,
  employees,
  employee_profiles,
  reviews,
  supplier_applications,
  suppliers,
} from '../database/schema/tables.ts';
import { BadRequestError } from '../errors/app-error.ts';
import { checkBranchSchedule } from './technician-availability.service.ts';
import { storageService } from './storage.service.ts';
import { matchingService } from './matching.service.ts';
import { calculateHaversineDistanceKm } from '../utils/geo.utils.ts';
export { calculateHaversineDistanceKm } from '../utils/geo.utils.ts';
import type {
  BranchSearchResultItem,
  SearchBranchesQuery,
  SearchBranchesResult,
  SearchSortOption,
} from '../types/search.types.ts';

/**
 * Ordena los resultados de búsqueda según el criterio seleccionado.
 * - 'recomendado': Algoritmo ponderado de emparejamiento oficial (API-24).
 * - 'distancia': Menor distancia al cliente.
 * - 'calificacion': Mayor rating_avg y reviews_count.
 * - 'precio': Menor precio base (los que no tienen precio van al final).
 */
export function sortSearchResults(
  items: BranchSearchResultItem[],
  sortBy: SearchSortOption = 'recomendado',
  radiusKm = 10,
): BranchSearchResultItem[] {
  const sorted = [...items];

  switch (sortBy) {
    case 'distancia':
      return sorted.sort((a, b) => a.distance_km - b.distance_km);

    case 'calificacion':
      return sorted.sort((a, b) => {
        if (b.rating_avg !== a.rating_avg) {
          return b.rating_avg - a.rating_avg;
        }
        if (b.reviews_count !== a.reviews_count) {
          return b.reviews_count - a.reviews_count;
        }
        return a.distance_km - b.distance_km;
      });

    case 'precio':
      return sorted.sort((a, b) => {
        const priceA = a.base_price !== null ? Number(a.base_price) : Infinity;
        const priceB = b.base_price !== null ? Number(b.base_price) : Infinity;
        if (priceA !== priceB) {
          return priceA - priceB;
        }
        return a.distance_km - b.distance_km;
      });

    case 'recomendado':
    default:
      return matchingService.rankBranchesForSearch(sorted, radiusKm);
  }
}

export class SearchService {
  /**
   * Búsqueda de sucursales por radio, categoría y filtros (API-23).
   */
  async searchBranches(
    query: SearchBranchesQuery,
    now = new Date(),
  ): Promise<SearchBranchesResult> {
    // 1. Validación de coordenadas obligatorias
    const lat = Number(query.lat);
    const lng = Number(query.lng);

    if (isNaN(lat) || lat < -90 || lat > 90) {
      throw new BadRequestError('El parámetro lat es obligatorio y debe estar entre -90 y 90.');
    }

    if (isNaN(lng) || lng < -180 || lng > 180) {
      throw new BadRequestError('El parámetro lng es obligatorio y debe estar entre -180 y 180.');
    }

    const radiusKm = query.radius_km !== undefined ? Number(query.radius_km) : 10;
    if (isNaN(radiusKm) || radiusKm < 1 || radiusKm > 50) {
      throw new BadRequestError('El parámetro radius_km debe ser un número entre 1 y 50.');
    }

    const sortOption: SearchSortOption = query.sort || 'recomendado';
    const validSortOptions: SearchSortOption[] = [
      'recomendado',
      'distancia',
      'calificacion',
      'precio',
    ];
    if (!validSortOptions.includes(sortOption)) {
      throw new BadRequestError(
        `El parámetro sort debe ser uno de: ${validSortOptions.join(', ')}.`,
      );
    }

    const availableNow = Boolean(query.available_now);
    const page = query.page && Number(query.page) > 0 ? Number(query.page) : 1;
    const limit = query.limit && Number(query.limit) > 0 ? Math.min(Number(query.limit), 50) : 20;

    let categoryIdBigInt: bigint | null = null;
    if (query.category_id) {
      try {
        categoryIdBigInt = BigInt(query.category_id);
      } catch {
        throw new BadRequestError('El category_id proporcionado es inválido.');
      }
    }

    // 2. Consultar sucursales de proveedores activos y aprobados con ubicación válida
    const branchRows = await db
      .select({
        id: branches.UniqueID,
        name: branches.name,
        businessId: branches.business_id,
        businessName: business.name,
        acceptingRequest: branches.accepting_request,
        timezone: branches.timezone,
        colony: addresses.colony,
        municipality: addresses.municipality,
        latitude: addresses.latitude,
        longitude: addresses.longitude,
        supplierId: suppliers.UniqueID,
        supplierType: suppliers.supplier_type,
        supplierUserId: suppliers.user_id,
      })
      .from(branches)
      .innerJoin(business, eq(branches.business_id, business.UniqueID))
      .innerJoin(addresses, eq(branches.address_id, addresses.UniqueID))
      .innerJoin(business_supplier, eq(business.UniqueID, business_supplier.business_id))
      .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
      .where(and(eq(business_supplier.active, true), eq(suppliers.active, true)));

    if (branchRows.length === 0) {
      return {
        data: [],
        pagination: { page, limit, total: 0, total_pages: 0 },
      };
    }

    // Filtrar solo proveedores que cuenten con solicitud aprobada (verificados)
    const supplierIds = Array.from(new Set(branchRows.map((b) => b.supplierId)));
    const approvedApplications = await db
      .select({ supplierId: supplier_applications.supplier_id })
      .from(supplier_applications)
      .where(
        and(
          inArray(supplier_applications.supplier_id, supplierIds),
          eq(supplier_applications.state, 'aprobada'),
        ),
      );

    const approvedSupplierSet = new Set(approvedApplications.map((a) => a.supplierId.toString()));
    const verifiedBranches = branchRows.filter((b) =>
      approvedSupplierSet.has(b.supplierId.toString()),
    );

    if (verifiedBranches.length === 0) {
      return {
        data: [],
        pagination: { page, limit, total: 0, total_pages: 0 },
      };
    }

    const branchIds = verifiedBranches.map((b) => b.id);

    // 3. Consultar categorías de las sucursales
    const branchCategories = await db
      .select({
        branchId: branches_categories.branch_id,
        categoryId: branches_categories.category_id,
        basePrice: branches_categories.base_price,
        active: branches_categories.active,
      })
      .from(branches_categories)
      .where(
        and(
          inArray(branches_categories.branch_id, branchIds),
          eq(branches_categories.active, true),
        ),
      );

    // 4. Consultar horarios para evaluar si están abiertas
    const allSchedules = await db
      .select({
        branchId: branch_schedules.branch_id,
        day_of_week: branch_schedules.day_of_week,
        open_time: branch_schedules.open_time,
        close_time: branch_schedules.close_time,
        active: branch_schedules.active,
      })
      .from(branch_schedules)
      .where(inArray(branch_schedules.branch_id, branchIds));

    // 5. Consultar empleados de las sucursales para fotos y reseñas
    const branchEmployees = await db
      .select({
        id: employees.UniqueID,
        branchId: employees.branch_id,
        userId: employees.user_id,
      })
      .from(employees)
      .where(and(inArray(employees.branch_id, branchIds), eq(employees.active, true)));

    const employeeIds = branchEmployees.map((e) => e.id);
    const profiles =
      employeeIds.length > 0
        ? await db
            .select({
              employeeId: employee_profiles.employee_id,
              photoKey: employee_profiles.photo_key,
            })
            .from(employee_profiles)
            .where(inArray(employee_profiles.employee_id, employeeIds))
        : [];

    // 6. Consultar reseñas públicas agrupadas
    const allUserIds = Array.from(
      new Set([
        ...verifiedBranches.map((b) => b.supplierUserId),
        ...branchEmployees.map((e) => e.userId),
      ]),
    );

    const publicReviews =
      allUserIds.length > 0
        ? await db
            .select({
              revieweeId: reviews.reviewee_id,
              rating: reviews.rating,
            })
            .from(reviews)
            .where(and(inArray(reviews.reviewee_id, allUserIds), eq(reviews.status, 'publicada')))
        : [];

    // 7. Evaluar cada sucursal: distancia, filtro de categoría, disponibilidad y métricas
    const matchedItems: BranchSearchResultItem[] = [];

    for (const b of verifiedBranches) {
      if (b.latitude === null || b.longitude === null) continue;

      const branchLat = Number(b.latitude);
      const branchLng = Number(b.longitude);
      if (isNaN(branchLat) || isNaN(branchLng)) continue;

      const distanceKm = calculateHaversineDistanceKm(lat, lng, branchLat, branchLng);
      if (distanceKm > radiusKm) continue;

      // Filtro de categoría
      const categoriesForBranch = branchCategories.filter((c) => c.branchId === b.id);
      let basePrice: string | null = null;

      if (categoryIdBigInt !== null) {
        const foundCat = categoriesForBranch.find((c) => c.categoryId === categoryIdBigInt);
        if (!foundCat) continue; // No ofrece la categoría buscada
        basePrice = Number(foundCat.basePrice).toFixed(2);
      }

      // Evaluar horario de atención
      const schedulesForBranch = allSchedules.filter((s) => s.branchId === b.id);
      const scheduleResult = checkBranchSchedule(
        { accepting_request: b.acceptingRequest, timezone: b.timezone },
        schedulesForBranch,
        now,
      );

      const isOpenNow = scheduleResult.isOpen;
      if (availableNow && !isOpenNow) continue;

      // Calcular calificación y reseñas
      const branchEmps = branchEmployees.filter((e) => e.branchId === b.id);
      const relevantUserIds = new Set([b.supplierUserId, ...branchEmps.map((e) => e.userId)]);
      const reviewsForBranch = publicReviews.filter((r) => relevantUserIds.has(r.revieweeId));

      const reviewsCount = reviewsForBranch.length;
      const ratingAvg =
        reviewsCount > 0
          ? Math.round(
              (reviewsForBranch.reduce((acc, curr) => acc + curr.rating, 0) / reviewsCount) * 10,
            ) / 10
          : 0;

      // Foto de perfil
      let logoUrl: string | null = null;
      const empIdsForBranch = new Set(branchEmps.map((e) => e.id));
      const firstPhoto = profiles.find(
        (p) => empIdsForBranch.has(p.employeeId) && Boolean(p.photoKey),
      );
      if (firstPhoto?.photoKey) {
        try {
          logoUrl = storageService.generateSignedUrl({
            file_key: firstPhoto.photoKey,
            expires_in_minutes: 180,
          }).signed_url;
        } catch {
          logoUrl = null;
        }
      }

      matchedItems.push({
        id: b.id.toString(),
        name: b.name,
        business_name: b.businessName,
        supplier_type: b.supplierType,
        logo_url: logoUrl,
        latitude: branchLat,
        longitude: branchLng,
        distance_km: distanceKm,
        rating_avg: ratingAvg,
        reviews_count: reviewsCount,
        base_price: basePrice,
        open_now: isOpenNow,
      });
    }

    // 8. Ordenar según el criterio solicitado (API-24 algoritmo de emparejamiento para 'recomendado')
    const sortedItems = sortSearchResults(matchedItems, sortOption, radiusKm);

    // 9. Aplicar paginación
    const total = sortedItems.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const paginatedItems = sortedItems.slice(startIndex, startIndex + limit);

    return {
      data: paginatedItems,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
      },
    };
  }
}

export const searchService = new SearchService();
