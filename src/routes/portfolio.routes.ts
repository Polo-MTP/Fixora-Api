import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// Agregar fotos a un trabajo que ya existe (autenticado)
router.post('/:id/media', authenticateToken, portfolioController.addMediaToWork);

// Quitar un trabajo del portafolio (autenticado)
router.delete('/:id', authenticateToken, portfolioController.deletePortfolioWork);

export default router;
