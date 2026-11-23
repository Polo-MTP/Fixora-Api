import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import {
  createServiceRequestController,
  createEmergencyServiceRequestController,
} from '../controllers/service-request-creation.controller.ts';
import {
  changeServiceRequestStatus,
  getOneServiceRequest,
  listMyServiceRequests,
  listServiceRequestEvents,
  acceptServiceRequestController,
  rejectServiceRequestController,
  cancelServiceRequestController,
  getRequestTrackingController,
} from '../controllers/service-request-status.controller.ts';
import {
  approvePriceAdjustmentController,
  listPriceAdjustmentsController,
  proposePriceAdjustmentController,
  rejectPriceAdjustmentController,
} from '../controllers/price-adjustment.controller.ts';

const router = Router();
router.use(authenticateToken);

router.get('/', listMyServiceRequests);
router.post('/emergency', createEmergencyServiceRequestController);
router.post('/', createServiceRequestController);
router.get('/:id/events', listServiceRequestEvents);
router.get('/:id/tracking', getRequestTrackingController);
router.post('/:id/accept', acceptServiceRequestController);
router.post('/:id/reject', rejectServiceRequestController);
router.post('/:id/cancel', cancelServiceRequestController);
// Ajustes de precio (API-36): el técnico propone, el cliente aprueba o rechaza.
router.get('/:id/price-adjustments', listPriceAdjustmentsController);
router.post('/:id/price-adjustments', proposePriceAdjustmentController);
router.post('/:id/price-adjustments/:adjustmentId/approve', approvePriceAdjustmentController);
router.post('/:id/price-adjustments/:adjustmentId/reject', rejectPriceAdjustmentController);
router.post('/:id/status', changeServiceRequestStatus);
router.patch('/:id/status', changeServiceRequestStatus);
router.get('/:id', getOneServiceRequest);

export default router;
