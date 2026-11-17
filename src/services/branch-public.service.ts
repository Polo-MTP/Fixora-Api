import { and, desc, eq, inArray } from 'drizzle-orm';
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
  personal_data,
  reviews,
  supplier_applications,
  suppliers,
} from '../database/schema/tables.ts';
import { NotFoundError } from '../errors/app-error.ts';
import { portfolioService } from './portfolio.service.ts';
import { storageService } from './storage.service.ts';
import type {
  BranchCategoryResponse,
  BranchPublicLocation,
  BranchPublicProfileResponse,
  BranchReviewSummary,
  BranchScheduleResponse,
} from '../types/portfolio.types.ts';

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

    // 3. Determinar si el proveedor tiene insignia de verificado (solicitud aprobada)
    let isVerified = false;
    if (supplierRow) {
      const [approvedApp] = await db
        .select({ id: supplier_applications.UniqueID })
        .from(supplier_applications)
        .where(
          and(
            eq(supplier_applications.supplier_id, supplierRow.supplierId),
            eq(supplier_applications.state, 'aprobada'),
          ),
        )
        .limit(1);

      isVerified = Boolean(approvedApp);
    }

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

    // 10. Calificación promedio y reseñas públicas
    // Se agregan las reseñas de los usuarios técnicos o proveedor de la sucursal
    const userIdsToEvaluate = [
      ...(supplierRow?.userId ? [supplierRow.userId] : []),
      ...branchEmployees.map((e) => e.userId),
    ];

    let ratingAvg = 0;
    let reviewsCount = 0;
    const latestReviews: BranchReviewSummary[] = [];

    if (userIdsToEvaluate.length > 0) {
      const reviewRows = await db
        .select({
          id: reviews.UniqueID,
          rating: reviews.rating,
          comment: reviews.comment,
          author_id: reviews.author_id,
          author_name: personal_data.name,
          author_lastname: personal_data.lastname_p,
        })
        .from(reviews)
        .leftJoin(personal_data, eq(reviews.author_id, personal_data.user_id))
        .where(
          and(inArray(reviews.reviewee_id, userIdsToEvaluate), eq(reviews.status, 'publicada')),
        )
        .orderBy(desc(reviews.UniqueID))
        .limit(5);

      if (reviewRows.length > 0) {
        // Consultar conteo total y suma para rating_avg preciso
        const allReviews = await db
          .select({ rating: reviews.rating })
          .from(reviews)
          .where(
            and(inArray(reviews.reviewee_id, userIdsToEvaluate), eq(reviews.status, 'publicada')),
          );

        reviewsCount = allReviews.length;
        const sum = allReviews.reduce((acc, curr) => acc + curr.rating, 0);
        ratingAvg = reviewsCount > 0 ? Math.round((sum / reviewsCount) * 10) / 10 : 0;

        for (const rev of reviewRows) {
          const initial = rev.author_lastname ? `${rev.author_lastname.charAt(0)}.` : '';
          const authorFormatted = rev.author_name
            ? `${rev.author_name} ${initial}`.trim()
            : 'Cliente';
          latestReviews.push({
            rating: rev.rating,
            comment: rev.comment,
            author_name: authorFormatted,
          });
        }
      }
    }

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
      rating_avg: ratingAvg,
      reviews_count: reviewsCount,
      total_jobs: Number(branchRow.total_jobs),
      accepting_request: branchRow.accepting_request,
      location,
      schedules,
      categories: categoriesList,
      portfolio,
      certificates,
      latest_reviews: latestReviews,
    };
  }
}

export const branchPublicService = new BranchPublicService();
