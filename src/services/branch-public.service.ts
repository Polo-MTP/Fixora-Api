import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  addresses,
  branches,
  branches_categories,
  branch_schedules,
  business,
  business_supplier,
  categories,
  employees,
  employee_profiles,
  employee_vehicles,
  suppliers,
} from '../database/schema/tables.ts';
import { NotFoundError } from '../errors/app-error.ts';
import { portfolioService } from './portfolio.service.ts';
import { listBranchReviews } from './review.service.ts';
import { storageService } from './storage.service.ts';
import { isBranchVerified } from './supplier-verification.rules.ts';
import type {
  BranchCategoryResponse,
  BranchPublicLocation,
  BranchPublicProfileResponse,
  BranchReviewSummary,
  BranchScheduleResponse,
} from '../types/portfolio.types.ts';

const PROFILE_REVIEWS_LIMIT = 10;
const LATEST_REVIEWS_LIMIT = 5;

export class BranchPublicService {
  /**
   * Obtiene la ficha pública completa de una sucursal (Ticket API-21).
   * Consulta pública: no requiere autenticación y muestra la información que ve el cliente
   * al seleccionar un proveedor en el mapa.
   */
  async getBranchPublicProfile(
    branchIdInput: string | bigint,
  ): Promise<BranchPublicProfileResponse> {
    const branchId = BigInt(branchIdInput);

    // 1. Obtener la sucursal con su negocio y dirección
    const [branchRow] = await db
      .select({
        id: branches.UniqueID,
        name: branches.name,
        phone: branches.phone,
        total_jobs: branches.total_jobs,
        accepting_request: branches.accepting_request,
        description: branches.description,
        rating_avg: branches.rating_avg,
        reviews_count: branches.reviews_count,
        business_id: branches.business_id,
        business_name: business.name,
        business_phone: business.phone,
        colony: addresses.colony,
        municipality: addresses.municipality,
        latitude: addresses.latitude,
        longitude: addresses.longitude,
      })
      .from(branches)
      .innerJoin(business, eq(branches.business_id, business.UniqueID))
      .innerJoin(addresses, eq(branches.address_id, addresses.UniqueID))
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branchRow) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    // 2. Obtener el proveedor vinculado al negocio
    const [supplierRow] = await db
      .select({
        supplierId: suppliers.UniqueID,
        supplierType: suppliers.supplier_type,
        userId: suppliers.user_id,
      })
      .from(business_supplier)
      .innerJoin(suppliers, eq(business_supplier.supplier_id, suppliers.UniqueID))
      .where(
        and(
          eq(business_supplier.business_id, branchRow.business_id),
          eq(business_supplier.active, true),
        ),
      )
      .limit(1);

    // 3. Insignia de verificado: el proveedor tiene su solicitud de alta aprobada (misma regla que API-56)
    const isVerified = supplierRow ? await isBranchVerified(branchId) : false;

    // 4. Empleados de la sucursal y placas de sus vehículos activos
    const branchEmployees = await db
      .select({
        id: employees.UniqueID,
        userId: employees.user_id,
      })
      .from(employees)
      .where(and(eq(employees.branch_id, branchId), eq(employees.active, true)));

    const employeeIds = branchEmployees.map((e) => e.id);
    let plates: string[] = [];
    if (employeeIds.length > 0) {
      const vehicles = await db
        .select({
          plate: employee_vehicles.plate,
        })
        .from(employee_vehicles)
        .where(
          and(
            inArray(employee_vehicles.employee_id, employeeIds),
            eq(employee_vehicles.active, true),
          ),
        );

      plates = Array.from(new Set(vehicles.map((v) => v.plate).filter(Boolean)));
    }

    // 5. Foto de perfil o logo del técnico / negocio
    let logoUrl: string | null = null;
    if (employeeIds.length > 0) {
      // Buscar foto del primer empleado con foto (por ejemplo el encargado o técnico)
      const profiles = await db
        .select({
          photo_key: employee_profiles.photo_key,
        })
        .from(employee_profiles)
        .where(inArray(employee_profiles.employee_id, employeeIds));

      const firstPhoto = profiles.find((p) => Boolean(p.photo_key));
      if (firstPhoto?.photo_key) {
        try {
          logoUrl = storageService.generateSignedUrl({
            file_key: firstPhoto.photo_key,
            expires_in_minutes: 180,
          }).signed_url;
        } catch {
          logoUrl = null;
        }
      }
    }

    // 6. Horarios de atención de la sucursal
    const scheduleRows = await db
      .select({
        day_of_week: branch_schedules.day_of_week,
        open_time: branch_schedules.open_time,
        close_time: branch_schedules.close_time,
        active: branch_schedules.active,
      })
      .from(branch_schedules)
      .where(eq(branch_schedules.branch_id, branchId))
      .orderBy(branch_schedules.day_of_week);

    const schedules: BranchScheduleResponse[] = scheduleRows.map((s) => ({
      day_of_week: s.day_of_week,
      open_time: typeof s.open_time === 'string' ? s.open_time.slice(0, 5) : String(s.open_time),
      close_time:
        typeof s.close_time === 'string' ? s.close_time.slice(0, 5) : String(s.close_time),
      active: s.active,
    }));

    // 7. Categorías activas ofrecidas por la sucursal con su precio base
    const categoryRows = await db
      .select({
        category_id: branches_categories.category_id,
        category_name: categories.name,
        icon_key: categories.icon_key,
        base_price: branches_categories.base_price,
        duration_minutes: branches_categories.duration_minutes,
      })
      .from(branches_categories)
      .innerJoin(categories, eq(branches_categories.category_id, categories.UniqueID))
      .where(
        and(eq(branches_categories.branch_id, branchId), eq(branches_categories.active, true)),
      );

    const categoriesList: BranchCategoryResponse[] = categoryRows.map((c) => ({
      category_id: c.category_id.toString(),
      category_name: c.category_name,
      icon_key: c.icon_key,
      base_price: Number(c.base_price).toFixed(2),
      duration_minutes: c.duration_minutes,
    }));

    // 8. Trabajos del portafolio con fotos
    const portfolio = await portfolioService.getBranchPortfolio(branchId);

    // 9. Certificados públicos aprobados
    const certificates = await portfolioService.getBranchCertificates(branchId);

    // 10. Calificación y reseñas de clientes (API-39)
    // rating_avg y reviews_count los mantiene al día RatingObserver al guardarse cada reseña;
    // aquí solo se leen. La lista trae la primera página; el resto, en GET /api/branches/:id/reviews.
    const reviewsPage = await listBranchReviews(branchId, 1, PROFILE_REVIEWS_LIMIT);
    const latestReviews: BranchReviewSummary[] = reviewsPage.items
      .slice(0, LATEST_REVIEWS_LIMIT)
      .map((review) => ({
        rating: review.rating,
        comment: review.comment,
        author_name: review.author_name,
        created_at: review.created_at,
      }));

    const location: BranchPublicLocation = {
      colony: branchRow.colony,
      municipality: branchRow.municipality,
      latitude: branchRow.latitude !== null ? Number(branchRow.latitude) : null,
      longitude: branchRow.longitude !== null ? Number(branchRow.longitude) : null,
    };

    return {
      id: branchRow.id.toString(),
      name: branchRow.name,
      business_name: branchRow.business_name,
      supplier_type: supplierRow?.supplierType ?? 'independiente',
      description: branchRow.description,
      logo_url: logoUrl,
      phone: branchRow.phone || branchRow.business_phone || null,
      is_verified: isVerified,
      plates,
      // Un decimal, igual que en la búsqueda, para que ambas pantallas muestren la misma cifra.
      rating_avg: Math.round(Number(branchRow.rating_avg ?? 0) * 10) / 10,
      reviews_count: branchRow.reviews_count,
      total_jobs: Number(branchRow.total_jobs),
      accepting_request: branchRow.accepting_request,
      location,
      schedules,
      categories: categoriesList,
      portfolio,
      certificates,
      latest_reviews: latestReviews,
      reviews: reviewsPage,
    };
  }
}

export const branchPublicService = new BranchPublicService();
