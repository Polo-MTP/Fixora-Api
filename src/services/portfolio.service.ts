import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.ts';
import {
  branches,
  branches_categories,
  business,
  business_supplier,
  categories,
  employees,
  portfolio_media,
  portfolio_works,
  supplier_documents,
  suppliers,
  type_documents,
} from '../database/schema/tables.ts';
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors/app-error.ts';
import { storageService } from './storage.service.ts';
import type { AuthenticatedUser } from '../middlewares/auth.middleware.ts';
import type {
  BranchCategoryInput,
  BranchCategoryResponse,
  CertificateResponse,
  PortfolioMediaResponse,
  PortfolioWorkInput,
  PortfolioWorkResponse,
} from '../types/portfolio.types.ts';

/**
 * Valida que el usuario tenga acceso de gestión a una sucursal específica.
 * Permitido para:
 * - Administrador
 * - Gerente asignado a dicha sucursal
 * - Proveedor dueño del negocio al que pertenece la sucursal
 */
export async function checkBranchAccess(branchId: bigint, user: AuthenticatedUser): Promise<void> {
  if (user.role === 'administrador') {
    return;
  }

  // 1. Si es gerente, verificar asignación activa en la sucursal
  if (user.role === 'gerente') {
    const [emp] = await db
      .select({ id: employees.UniqueID })
      .from(employees)
      .where(
        and(
          eq(employees.user_id, BigInt(user.id)),
          eq(employees.branch_id, branchId),
          eq(employees.active, true),
        ),
      )
      .limit(1);

    if (emp) return;
  }

  // 2. Si es proveedor, verificar propiedad del negocio de la sucursal
  if (user.role === 'proveedor') {
    const [supplier] = await db
      .select({ id: suppliers.UniqueID })
      .from(suppliers)
      .where(eq(suppliers.user_id, BigInt(user.id)))
      .limit(1);

    if (supplier) {
      const [branchOwner] = await db
        .select({ branchId: branches.UniqueID })
        .from(branches)
        .innerJoin(business, eq(branches.business_id, business.UniqueID))
        .innerJoin(business_supplier, eq(business_supplier.business_id, business.UniqueID))
        .where(and(eq(branches.UniqueID, branchId), eq(business_supplier.supplier_id, supplier.id)))
        .limit(1);

      if (branchOwner) return;
    }
  }

  throw new ForbiddenError('No tienes permisos para administrar esta sucursal.');
}

export class PortfolioService {
  /**
   * Obtiene la lista de trabajos del portafolio publicados para una sucursal.
   */
  async getBranchPortfolio(branchIdInput: string | bigint): Promise<PortfolioWorkResponse[]> {
    const branchId = BigInt(branchIdInput);

    const [branch] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branch) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    const works = await db
      .select({
        id: portfolio_works.UniqueID,
        branch_id: portfolio_works.branch_id,
        title: portfolio_works.title,
        description: portfolio_works.description,
      })
      .from(portfolio_works)
      .where(eq(portfolio_works.branch_id, branchId))
      .orderBy(desc(portfolio_works.UniqueID));

    if (works.length === 0) {
      return [];
    }

    const workIds = works.map((w) => w.id);
    const mediaRows = await db
      .select({
        id: portfolio_media.UniqueID,
        work_id: portfolio_media.work_id,
        file_key: portfolio_media.file_key,
        description: portfolio_media.description,
      })
      .from(portfolio_media)
      .where(inArray(portfolio_media.work_id, workIds));

    return works.map((work) => {
      const workMedia = mediaRows
        .filter((m) => m.work_id === work.id)
        .map((m): PortfolioMediaResponse => {
          let signedUrl: string;
          try {
            const urlResult = storageService.generateSignedUrl({
              file_key: m.file_key,
              expires_in_minutes: 120,
            });
            signedUrl = urlResult.signed_url;
          } catch {
            signedUrl = '';
          }

          return {
            id: m.id.toString(),
            file_key: m.file_key,
            url: signedUrl,
            description: m.description,
          };
        });

      return {
        id: work.id.toString(),
        branch_id: work.branch_id.toString(),
        title: work.title,
        description: work.description,
        media: workMedia,
      };
    });
  }

  /**
   * Agrega un nuevo trabajo con fotos al portafolio de la sucursal.
   */
  async addWorkToPortfolio(
    branchIdInput: string | bigint,
    input: PortfolioWorkInput,
    user: AuthenticatedUser,
  ): Promise<PortfolioWorkResponse> {
    if (!input || typeof input.title !== 'string' || !input.title.trim()) {
      throw new BadRequestError('El título del trabajo es obligatorio.');
    }

    const title = input.title.trim();
    if (title.length > 255) {
      throw new BadRequestError('El título no puede exceder los 255 caracteres.');
    }

    if (!Array.isArray(input.media) || input.media.length === 0 || input.media.length > 10) {
      throw new BadRequestError('Debes incluir entre 1 y 10 fotos para el trabajo del portafolio.');
    }

    for (const item of input.media) {
      if (!item.file_key || typeof item.file_key !== 'string' || !item.file_key.trim()) {
        throw new BadRequestError('Cada foto debe incluir un file_key válido.');
      }
    }

    const branchId = BigInt(branchIdInput);

    const [branch] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branch) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    await checkBranchAccess(branchId, user);

    const description = input.description ? input.description.trim() : null;

    // Insertar trabajo y fotos asociadas en una transacción
    const result = await db.transaction(async (tx) => {
      const [newWork] = await tx
        .insert(portfolio_works)
        .values({
          branch_id: branchId,
          title,
          description,
        })
        .returning({
          id: portfolio_works.UniqueID,
          branch_id: portfolio_works.branch_id,
          title: portfolio_works.title,
          description: portfolio_works.description,
        });

      const mediaToInsert = input.media.map((m) => ({
        work_id: newWork.id,
        file_key: m.file_key.trim(),
        description: m.description ? m.description.trim() : null,
      }));

      const insertedMedia = await tx.insert(portfolio_media).values(mediaToInsert).returning({
        id: portfolio_media.UniqueID,
        file_key: portfolio_media.file_key,
        description: portfolio_media.description,
      });

      return {
        newWork,
        insertedMedia,
      };
    });

    const mediaResponse: PortfolioMediaResponse[] = result.insertedMedia.map((m) => {
      let signedUrl: string;
      try {
        const urlResult = storageService.generateSignedUrl({
          file_key: m.file_key,
          expires_in_minutes: 120,
        });
        signedUrl = urlResult.signed_url;
      } catch {
        signedUrl = '';
      }

      return {
        id: m.id.toString(),
        file_key: m.file_key,
        url: signedUrl,
        description: m.description,
      };
    });

    return {
      id: result.newWork.id.toString(),
      branch_id: result.newWork.branch_id.toString(),
      title: result.newWork.title,
      description: result.newWork.description,
      media: mediaResponse,
    };
  }

  /**
   * Elimina un trabajo del portafolio y sus fotos asociadas.
   */
  async deletePortfolioWork(workIdInput: string | bigint, user: AuthenticatedUser): Promise<void> {
    const workId = BigInt(workIdInput);

    const [work] = await db
      .select({
        id: portfolio_works.UniqueID,
        branch_id: portfolio_works.branch_id,
      })
      .from(portfolio_works)
      .where(eq(portfolio_works.UniqueID, workId))
      .limit(1);

    if (!work) {
      throw new NotFoundError('Trabajo del portafolio no encontrado.');
    }

    await checkBranchAccess(work.branch_id, user);

    await db.transaction(async (tx) => {
      await tx.delete(portfolio_media).where(eq(portfolio_media.work_id, workId));

      await tx.delete(portfolio_works).where(eq(portfolio_works.UniqueID, workId));
    });
  }

  /**
   * Reemplaza la lista de categorías activas para una sucursal (Ticket API-20).
   * Manda la lista completa; las que no vengan se desactivan.
   */
  async updateBranchCategories(
    branchIdInput: string | bigint,
    categoryInputs: BranchCategoryInput[],
    user: AuthenticatedUser,
  ): Promise<BranchCategoryResponse[]> {
    if (!Array.isArray(categoryInputs) || categoryInputs.length === 0) {
      throw new BadRequestError('Debes especificar al menos una categoría con su precio base.');
    }

    // Validar entradas
    const parsedCategories: { categoryId: bigint; basePrice: string; durationMinutes: number }[] =
      [];
    for (const cat of categoryInputs) {
      if (!cat.category_id) {
        throw new BadRequestError(
          'Cada categoría debe tener un category_id válido y un base_price numérico mayor o igual a 0.',
        );
      }

      const catId = BigInt(cat.category_id);
      const priceNum = Number(cat.base_price);
      if (isNaN(priceNum) || priceNum < 0) {
        throw new BadRequestError(
          'Cada categoría debe tener un category_id válido y un base_price numérico mayor o igual a 0.',
        );
      }

      const duration = cat.duration_minutes !== undefined ? Number(cat.duration_minutes) : 60;
      if (isNaN(duration) || duration < 15) {
        throw new BadRequestError(
          `La duración estimada para la categoría ${cat.category_id} debe ser de al menos 15 minutos.`,
        );
      }

      parsedCategories.push({
        categoryId: catId,
        basePrice: priceNum.toFixed(2),
        durationMinutes: duration,
      });
    }

    const branchId = BigInt(branchIdInput);

    const [branch] = await db
      .select({ id: branches.UniqueID })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branch) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    await checkBranchAccess(branchId, user);

    // Verificar que todas las categorías existan en el catálogo global
    const uniqueCatIds = Array.from(new Set(parsedCategories.map((c) => c.categoryId)));
    const existingGlobalCats = await db
      .select({ id: categories.UniqueID, name: categories.name, icon_key: categories.icon_key })
      .from(categories)
      .where(inArray(categories.UniqueID, uniqueCatIds));

    if (existingGlobalCats.length !== uniqueCatIds.length) {
      throw new BadRequestError('Una o más categorías especificadas no existen en el sistema.');
    }

    await db.transaction(async (tx) => {
      // 1. Desactivar las categorías que ya no están en la lista
      await tx
        .update(branches_categories)
        .set({ active: false })
        .where(eq(branches_categories.branch_id, branchId));

      // 2. Insertar o reactivar las categorías proporcionadas
      for (const item of parsedCategories) {
        const [existing] = await tx
          .select({ id: branches_categories.UniqueID })
          .from(branches_categories)
          .where(
            and(
              eq(branches_categories.branch_id, branchId),
              eq(branches_categories.category_id, item.categoryId),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(branches_categories)
            .set({
              base_price: item.basePrice,
              duration_minutes: item.durationMinutes,
              active: true,
            })
            .where(eq(branches_categories.UniqueID, existing.id));
        } else {
          await tx.insert(branches_categories).values({
            branch_id: branchId,
            category_id: item.categoryId,
            base_price: item.basePrice,
            duration_minutes: item.durationMinutes,
            active: true,
          });
        }
      }
    });

    // Consultar lista final actualizada
    const updatedRows = await db
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

    return updatedRows.map((r) => ({
      category_id: r.category_id.toString(),
      category_name: r.category_name,
      icon_key: r.icon_key,
      base_price: r.base_price,
      duration_minutes: r.duration_minutes,
    }));
  }

  /**
   * Obtiene los certificados aprobados y marcados como públicos para la sucursal / proveedor.
   */
  async getBranchCertificates(branchIdInput: string | bigint): Promise<CertificateResponse[]> {
    const branchId = BigInt(branchIdInput);

    const [branch] = await db
      .select({ businessId: branches.business_id })
      .from(branches)
      .where(eq(branches.UniqueID, branchId))
      .limit(1);

    if (!branch) {
      throw new NotFoundError('Sucursal no encontrada.');
    }

    const [bs] = await db
      .select({ supplierId: business_supplier.supplier_id })
      .from(business_supplier)
      .where(eq(business_supplier.business_id, branch.businessId))
      .limit(1);

    if (!bs) {
      return [];
    }

    const docs = await db
      .select({
        id: supplier_documents.UniqueID,
        file_key: supplier_documents.file_key,
        type_name: type_documents.name,
      })
      .from(supplier_documents)
      .innerJoin(type_documents, eq(supplier_documents.type_document_id, type_documents.UniqueID))
      .where(
        and(
          eq(supplier_documents.supplier_id, bs.supplierId),
          eq(supplier_documents.is_public, true),
        ),
      );

    return docs.map((doc) => {
      let signedUrl: string;
      try {
        const urlRes = storageService.generateSignedUrl({
          file_key: doc.file_key,
          expires_in_minutes: 180,
        });
        signedUrl = urlRes.signed_url;
      } catch {
        signedUrl = '';
      }

      return {
        id: doc.id.toString(),
        type_name: doc.type_name,
        file_key: doc.file_key,
        url: signedUrl,
      };
    });
  }
}

export const portfolioService = new PortfolioService();
