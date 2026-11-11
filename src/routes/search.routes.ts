import { Router } from 'express';
import { searchController } from '../controllers/search.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// ============================================================
// BÚSQUEDA Y MAPA (API-23)
// ============================================================

// Buscar proveedores cercanos por radio, categoría y filtros
router.get('/branches', authenticateToken, searchController.searchBranches);

export default router;
