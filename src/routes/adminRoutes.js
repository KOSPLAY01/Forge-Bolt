import express from 'express';
import * as adminController from '../controllers/adminController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/users', authenticateToken, adminController.getAllUsers);
router.get('/orders', authenticateToken, adminController.getAllOrders);
router.get('/products/low-stock', authenticateToken, adminController.getLowStockProducts);

export default router;
