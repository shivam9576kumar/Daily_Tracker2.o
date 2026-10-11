import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { csesController } from '../controllers/csesController';

const router = Router();
router.use(authMiddleware);

router.get('/', csesController.overview);
router.patch('/settings', csesController.setEnabled);
router.post('/topic', csesController.selectTopic);
router.post('/topics/:topicId/restart', csesController.restart);
router.post('/problems/:taskId/skip', csesController.skip);
router.post('/problems/:taskId/retry', csesController.retry);
router.post('/return-ack', csesController.acknowledgeReturn);

export default router;
