
import { Router } from 'express';

import {
    authenticateToken
} from '../middlewares/auth.middleware.ts';

import {
    createStaffController
} from '../controllers/admin-staff.controller.ts';

const router = Router();

// POST /api/admin/staff
// Requiere token de acceso válido.
router.post(
    '/staff',
    authenticateToken,
    createStaffController
);

export default router;
