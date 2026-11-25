import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { authorizeRoles } from '../middlewares/role.middleware.ts';
import {
  addReportCommentController,
  addReportEvidenceController,
  assignReportController,
  changeReportStatusController,
  createReportController,
  getReportController,
  listReportsController,
} from '../controllers/report.controller.ts';

const router = Router();

router.use(authenticateToken);

// Reportes, garantías y reclamaciones (API-40).
// Quien participa en un servicio levanta el caso; ve y comenta solo los suyos.
router.post('/', createReportController);
router.get('/', listReportsController);
router.get('/:id', getReportController);
router.post('/:id/comments', addReportCommentController);
router.post('/:id/evidence', addReportEvidenceController);

// Atención de Soporte y Administrador.
router.post(
  '/:id/status',
  authorizeRoles('soporte', 'administrador'),
  changeReportStatusController,
);
router.post('/:id/assign', authorizeRoles('soporte', 'administrador'), assignReportController);

export default router;
