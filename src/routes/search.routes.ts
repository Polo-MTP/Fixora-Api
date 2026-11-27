import { Router } from 'express';
import { searchController } from '../controllers/search.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// ============================================================
// BÚSQUEDA Y MAPA (API-23)
// ============================================================

// Buscar proveedores cercanos por radio, categoría y filtros
router.get('/branches', authenticateToken, searchController.searchBranches);

// Servicios recomendados para la pantalla principal del cliente (API-47)
router.get('/recommendations', authenticateToken, (req, res, next) =>
  searchController.recommendations(req, res, next),
);

export default router;
