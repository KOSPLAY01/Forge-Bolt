import express from 'express';
import * as paymentController from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/initiate', authenticateToken, paymentController.initiatePayment);
router.post('/webhook', paymentController.paystackWebhook);

export default router;
