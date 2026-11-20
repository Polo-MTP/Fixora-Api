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
} from '../controllers/service-request-status.controller.ts';
import {
  getChatController,
  markChatReadController,
  sendChatMessageController,
} from '../controllers/chat.controller.ts';

const router = Router();
router.use(authenticateToken);

router.get('/', listMyServiceRequests);
router.post('/emergency', createEmergencyServiceRequestController);
router.post('/', createServiceRequestController);
router.get('/:id/events', listServiceRequestEvents);
router.post('/:id/accept', acceptServiceRequestController);
router.post('/:id/reject', rejectServiceRequestController);
router.post('/:id/cancel', cancelServiceRequestController);
router.post('/:id/status', changeServiceRequestStatus);
// Chat por solicitud (API-35)
router.get('/:id/chat', getChatController);
router.post('/:id/chat/messages', sendChatMessageController);
router.post('/:id/chat/read', markChatReadController);
router.get('/:id', getOneServiceRequest);

export default router;
