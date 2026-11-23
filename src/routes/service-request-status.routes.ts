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
import {
  confirmPaymentController,
  listRequestPaymentsController,
  registerPaymentController,
  rejectPaymentController,
} from '../controllers/payment.controller.ts';

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
// Pagos (API-37): el cliente registra, el proveedor confirma o dice que no lo recibió.
router.get('/:id/payments', listRequestPaymentsController);
router.post('/:id/payments', registerPaymentController);
router.post('/:id/payments/:paymentId/confirm', confirmPaymentController);
router.post('/:id/payments/:paymentId/reject', rejectPaymentController);
router.post('/:id/status', changeServiceRequestStatus);
router.patch('/:id/status', changeServiceRequestStatus);
router.get('/:id', getOneServiceRequest);

export default router;
