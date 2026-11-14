import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware.ts';
import { createServiceRequestController } from '../controllers/service-request-creation.controller.ts';
import {
    changeServiceRequestStatus,
    getOneServiceRequest,
    listMyServiceRequests,
    listServiceRequestEvents,
} from '../controllers/service-request-status.controller.ts';

const router = Router();
router.use(authenticateToken);

router.get('/', listMyServiceRequests);
router.post('/', createServiceRequestController);
router.get('/:id/events', listServiceRequestEvents);
router.post('/:id/status', changeServiceRequestStatus);
router.get('/:id', getOneServiceRequest);

export default router;
