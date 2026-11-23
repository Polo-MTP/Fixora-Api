import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';
import { getReportConversationController } from '../controllers/chat.controller.ts';

const router = Router();

// La protección va en cada ruta (no en router.use) para no bloquear a futuro otras rutas de
// /api/reports que deban usar clientes o proveedores.
router.get(
    '/:reportId/conversation',
    authenticateToken,
    authorizeRoles('soporte', 'administrador'),
    getReportConversationController,
);

export default router;
