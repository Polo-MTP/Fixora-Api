import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

// Quitar un trabajo del portafolio (autenticado)
router.delete('/:id', authenticateToken, portfolioController.deletePortfolioWork);

export default router;
