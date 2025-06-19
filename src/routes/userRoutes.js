import express from 'express';
import * as userController from '../controllers/userController.js';
import { authenticateToken, upload } from '../middleware/auth.js';

const router = express.Router();

// Registration
router.post('/register', upload.single('image'), userController.register);
// Login
router.post('/auth/login', userController.login);
// Get profile
router.get('/auth/profile', authenticateToken, userController.getProfile);
// Update profile
router.put('/auth/profile', authenticateToken, upload.single('image'), userController.updateProfile);
// Forgot password
router.post('/auth/forgot-password', userController.forgotPassword);
// Reset password
router.post('/auth/reset-password', userController.resetPassword);

export default router;
