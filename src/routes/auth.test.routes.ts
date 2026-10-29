
import { Router } from 'express';
import { createTestUserController } from '../controllers/auth.test.controller.ts';

const router = Router();

router.post('/users', createTestUserController);

export default router;