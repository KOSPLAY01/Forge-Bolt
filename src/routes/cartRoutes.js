import express from 'express';
import * as cartController from '../controllers/cartController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, cartController.getCart);
router.post('/', authenticateToken, cartController.addToCart);
router.put('/:id', authenticateToken, cartController.updateCartItem);
router.delete('/:id', authenticateToken, cartController.deleteCartItem);

export default router;
