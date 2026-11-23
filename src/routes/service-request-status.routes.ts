
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
  getChatController,
  markChatReadController,
  sendChatMessageController,
} from '../controllers/chat.controller.ts';

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

// Solicitudes de servicio
router.get('/', listMyServiceRequests);
router.post('/emergency', createEmergencyServiceRequestController);
router.post('/', createServiceRequestController);

// Eventos y seguimiento
router.get('/:id/events', listServiceRequestEvents);
router.get('/:id/tracking', getRequestTrackingController);

// Acciones de la solicitud
router.post('/:id/accept', acceptServiceRequestController);
router.post('/:id/reject', rejectServiceRequestController);
router.post('/:id/cancel', cancelServiceRequestController);

// Ajustes de precio (API-36)
router.get('/:id/price-adjustments', listPriceAdjustmentsController);
router.post('/:id/price-adjustments', proposePriceAdjustmentController);
router.post(
  '/:id/price-adjustments/:adjustmentId/approve',
  approvePriceAdjustmentController,
);
router.post(
  '/:id/price-adjustments/:adjustmentId/reject',
  rejectPriceAdjustmentController,
);

// Pagos (API-37)
router.get('/:id/payments', listRequestPaymentsController);
router.post('/:id/payments', registerPaymentController);
router.post('/:id/payments/:paymentId/confirm', confirmPaymentController);
router.post('/:id/payments/:paymentId/reject', rejectPaymentController);

// Cambio de estado
router.post('/:id/status', changeServiceRequestStatus);
router.patch('/:id/status', changeServiceRequestStatus);

// Chat por solicitud (API-35)
router.get('/:id/chat', getChatController);
router.post('/:id/chat/messages', sendChatMessageController);
router.post('/:id/chat/read', markChatReadController);

// Obtener solicitud individual
router.get('/:id', getOneServiceRequest);

export default router;
