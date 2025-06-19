import express from 'express';
import * as orderController from '../controllers/orderController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/', authenticateToken, orderController.createOrder);
router.get('/', authenticateToken, orderController.getOrders);
router.get('/:id', authenticateToken, orderController.getOrderById);
router.put('/:id/status', authenticateToken, orderController.updateOrderStatus);
router.get('/history', authenticateToken, orderController.getOrderHistory);

export default router;
