import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller.ts';
import { employeeProfileController } from '../controllers/employee-profile.controller.ts';
import { branchPublicController } from '../controllers/branch-public.controller.ts';
import { listBranchReviewsController } from '../controllers/review.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// ============================================================
// FICHA PÚBLICA, PORTAFOLIO Y CERTIFICADOS (PÚBLICOS)
// ============================================================

// Ficha pública del proveedor / sucursal (API-21)
router.get('/:id/public', branchPublicController.getBranchPublicProfile);

// Reseñas de clientes sobre la sucursal, paginadas (API-39; público)
router.get('/:id/reviews', listBranchReviewsController);

// Listar trabajos del portafolio de una sucursal (público)
router.get('/:id/portfolio', portfolioController.getBranchPortfolio);

// Listar certificados públicos aprobados de una sucursal (público)
router.get('/:id/certificates', portfolioController.getBranchCertificates);

// ============================================================
// GESTIÓN DE SUCURSAL (AUTENTICADO)
// ============================================================

// Agregar un trabajo con fotos al portafolio
router.post('/:id/portfolio', authenticateToken, portfolioController.addWorkToPortfolio);

// Reemplazar categorías de la sucursal (las que no vengan se desactivan)
router.put('/:id/categories', authenticateToken, portfolioController.updateBranchCategories);

// Listar empleados de la sucursal enriquecidos con foto, biografía y vehículo.
// Va en /details porque GET /:id/employees es el listado básico del contrato (API-19).
router.get(
  '/:id/employees/details',
  authenticateToken,
  employeeProfileController.getBranchEmployees,
);

export default router;
