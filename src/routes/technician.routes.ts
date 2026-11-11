import { Router } from 'express';
import { technicianAvailabilityController } from '../controllers/technician-availability.controller.ts';
import { authenticateToken } from '../middlewares/auth.middleware.ts';

const router = Router();

router.use(authenticateToken);

// ============================================================
// DISPONIBILIDAD Y POSICIÓN EN REDIS DEL TÉCNICO AUTENTICADO (API-22)
// ============================================================

// Consultar disponibilidad y última posición
router.get('/me/availability', technicianAvailabilityController.getMyAvailability);

// Interruptor En línea / Fuera de línea y actualización de posición
router.put('/me/availability', technicianAvailabilityController.updateMyAvailability);
router.patch('/me/availability', technicianAvailabilityController.updateMyAvailability);

export default router;
