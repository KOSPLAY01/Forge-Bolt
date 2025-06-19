import express from 'express';
import * as productController from '../controllers/productController.js';
import { authenticateToken, upload } from '../middleware/auth.js';

const router = express.Router();

router.get('/', productController.getProducts);
router.get('/:id', productController.getProductById);
router.post('/', authenticateToken, upload.single('image'), productController.createProduct);
router.put('/:id', authenticateToken, upload.single('image'), productController.updateProduct);
router.delete('/:id', authenticateToken, productController.deleteProduct);

export default router;
