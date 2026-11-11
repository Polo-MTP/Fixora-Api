import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller.ts';
import { employeeProfileController } from '../controllers/employee-profile.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// ============================================================
// PORTAFOLIO Y CERTIFICADOS (PÚBLICOS)
// ============================================================

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

// Listar empleados de la sucursal enriquecidos con foto, biografía y vehículo
router.get('/:id/employees', authenticateToken, employeeProfileController.getBranchEmployees);

export default router;
