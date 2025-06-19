import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import supabase from '../utils/supabaseClient.js';
import fs from 'fs';
import cloudinary from '../utils/cloudinaryConfig.js';
import transporter from '../utils/mailer.js';

import dotenv from 'dotenv';
dotenv.config();

const generateToken = (user) =>
  jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.name,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

// Helper for uploading image
const uploadImage = async (file) => {
  if (!file) return null;
  const result = await cloudinary.uploader.upload(file.path, {
    folder: 'forge_and_bolt',
  });
  fs.unlinkSync(file.path);
  return result.secure_url;
};

export const register = async (req, res) => {
  const { email, password, name, role = 'customer' } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields are required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadImage(req.file);
    }
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([{ email, password: hashedPassword, name, profile_image_url: imageUrl, role }])
      .select()
      .single();
    if (userError) return res.status(400).json({ error: userError.message });
    await supabase.from('carts').insert([{ user_id: user.id, grand_total: 0 }]);
    res.status(201).json({
      message: 'User registered successfully',
      token: generateToken(user),
      user
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error || !user) return res.status(400).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
    const token = generateToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getProfile = async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (req.file) {
      const imageUrl = await uploadImage(req.file);
      updates.profile_image_url = imageUrl;
    }
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });
    const resetToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    const resetUrl = `https://forge-bolt-neon.vercel.app/reset-password?token=${resetToken}`;
    await transporter.sendMail({
      from: `"Forge & Bolt" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request',
      html: `<p>Click below to reset your password:</p><a href="${resetUrl}">${resetUrl}</a><p>Link expires in 15 minutes.</p>`,
    });
    res.json({ message: 'Reset email sent if the account exists.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    if (error || !user) return res.status(400).json({ error: 'Invalid token or user not found' });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', userId);
    if (updateError) {
      return res.status(500).json({ error: 'Failed to reset password' });
    }
    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token' });
  }
};
