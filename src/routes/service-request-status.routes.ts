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
router.post('/:id/status', changeServiceRequestStatus);
router.patch('/:id/status', changeServiceRequestStatus);
router.get('/:id', getOneServiceRequest);

export default router;
