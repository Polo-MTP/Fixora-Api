import { Router } from 'express';
import { employeeProfileController } from '../controllers/employee-profile.controller.ts';
import { technicianAvailabilityController } from '../controllers/technician-availability.controller.ts';
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

// ============================================================
// DISPONIBILIDAD Y POSICIÓN EN REDIS (API-22)
// ============================================================
router.get('/:id/availability', technicianAvailabilityController.getEmployeeAvailability);
router.put('/:id/availability', technicianAvailabilityController.updateEmployeeAvailability);
router.patch('/:id/availability', technicianAvailabilityController.updateEmployeeAvailability);

export default router;
