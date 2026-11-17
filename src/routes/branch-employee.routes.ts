import { Router } from 'express';

import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { createEmployee, listEmployees } from '../controllers/branch-employee.controller.ts';
import { getBranchAvailabilityController } from '../controllers/service-request-creation.controller.ts';

const router = Router();

router.get('/:id/availability', authenticateToken, getBranchAvailabilityController);
router.get('/:id/employees', authenticateToken, listEmployees);
router.post('/:id/employees', authenticateToken, createEmployee);

export default router;
