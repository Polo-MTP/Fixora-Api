import type { Request, Response, NextFunction } from 'express';
import { searchService } from '../services/search.service.ts';
import type { SearchSortOption } from '../types/search.types.ts';

export class SearchController {
  /**
   * GET /api/search/branches
   * Busca proveedores cercanos por radio, categoría, disponibilidad y ordenamiento (API-23).
   */
  async searchBranches(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { lat, lng, radius_km, category_id, sort, available_now, page, limit } = req.query;

      const result = await searchService.searchBranches({
        lat: Number(lat),
        lng: Number(lng),
        radius_km: radius_km !== undefined ? Number(radius_km) : undefined,
        category_id: typeof category_id === 'string' ? category_id : undefined,
        sort: typeof sort === 'string' ? (sort as SearchSortOption) : undefined,
        available_now: available_now === 'true',
        page: page !== undefined ? Number(page) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });

      res.status(200).json({
        success: true,
        message: 'Proveedores encontrados exitosamente.',
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const searchController = new SearchController();
