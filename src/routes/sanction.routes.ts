import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';
import {
  applySanctionController,
  getSanctionController,
  liftSanctionController,
  listMySanctionsController,
  listSanctionsController,
} from '../controllers/sanction.controller.ts';

const router = Router();

router.use(authenticateToken);

// Lo que la persona ve de su propia cuenta. Va antes de '/:id' para que "me" no se tome como id.
router.get('/me', listMySanctionsController);

// Aplicar, consultar y retirar sanciones: solo Soporte y Administrador (API-42).
router.post('/', authorizeRoles('soporte', 'administrador'), applySanctionController);
router.get('/', authorizeRoles('soporte', 'administrador'), listSanctionsController);
router.get('/:id', authorizeRoles('soporte', 'administrador'), getSanctionController);
router.post('/:id/lift', authorizeRoles('soporte', 'administrador'), liftSanctionController);

export default router;
