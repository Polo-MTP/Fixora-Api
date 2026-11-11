import { Router } from 'express';
import { employeeProfileController } from '../controllers/employee-profile.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

router.use(authenticateToken);

// ============================================================
// PERFIL (FOTO Y BIOGRAFÍA)
// ============================================================
router.get('/:id/profile', employeeProfileController.getEmployeeDetail);
router.put('/:id/profile', employeeProfileController.updateEmployeeProfile);

// ============================================================
// VEHÍCULO
// ============================================================
router.get('/:id/vehicle', employeeProfileController.getEmployeeVehicle);
router.put('/:id/vehicle', employeeProfileController.updateEmployeeVehicle);
router.delete('/:id/vehicle', employeeProfileController.deleteEmployeeVehicle);

export default router;
