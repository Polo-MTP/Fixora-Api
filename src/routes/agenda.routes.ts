import { Router } from 'express';

import {
  createBlockController,
  deleteBlockController,
  getAgendaController,
  updateBlockController,
} from '../controllers/agenda.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';

/** Agenda del proveedor: citas y bloqueos de horario (API-45). Se monta en /api/agenda. */
const router = Router();

router.use(authenticateToken, authorizeRoles('proveedor', 'gerente', 'empleado', 'administrador'));

router.get('/', getAgendaController);
router.post('/blocks', createBlockController);
router.patch('/blocks/:id', updateBlockController);
router.delete('/blocks/:id', deleteBlockController);

export default router;
