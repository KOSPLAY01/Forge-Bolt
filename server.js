import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: '/tmp' });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const generateToken = (user) =>
  jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username, 
      role: user.role          
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Missing auth token' });
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Invalid auth token' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalid or expired' });
    req.user = user;
    next();
  });
};

const uploadImage = async (file) => {
  if (!file) return null;
  const result = await cloudinary.uploader.upload(file.path, {
    folder: 'forge_and_bolt', 
  });
  fs.unlinkSync(file.path);
  return result.secure_url;
};


app.get('/', (req, res) => {
  res.send('Welcome to Forge & Bolt');
});


// User Management 

// Register
app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields are required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([{ email, password: hashedPassword, name }])
      .select()
      .single();

    if (userError) return res.status(400).json({ error: userError.message });

    // Create an empty cart for the user
    await supabase.from('carts').insert([{ user_id: user.id, grand_total: 0 }]);

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Login
app.post('/auth/login', async (req, res) => {
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
});

// Profile
app.get('/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Profile
app.put('/auth/profile', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { username, email } = req.body;
    const updates = { username, email };

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
});

// Forgot Password
app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    // Create JWT token with 1 hour expiry
    const resetToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const resetUrl = `http://localhost:5173/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: `"Forge & Bolt" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request',
      html: `<p>Click below to reset your password:</p><a href="${resetUrl}">${resetUrl}</a><p>Link expires in 15 minutes.</p>`,
    });

    // No need to store token or expiry in DB now
    res.json({ message: 'Reset email sent if the account exists.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Reset Password ---
app.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

  try {
    // Verify JWT token — throws if invalid or expired
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    // Get user by id
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
      console.error('Error updating password:', updateError);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});



//  Product Management 

app.get('/products', async (req, res) => {
  try {
    const { category, brand, price, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabase.from('products').select('*', { count: 'exact' }).range(from, to);

    if (category) {
      query = query.eq('category', category);
    }

    if (brand) {
      query = query.eq('brand', brand);
    }

    if (price) {
      query = query.lte('price', parseFloat(price));
    }

    const { data, error, count } = await query;

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      items: data,
      page: pageNum,
      limit: limitNum,
      total: count,
      totalPages: Math.ceil(count / limitNum)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Product not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/products', authenticateToken, upload.single('image'), async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add products' });
  }

  try {
    const { name, description, price, category, brand, stock_count, } = req.body;
    const imageUrl = await uploadImage(req.file);

    const { data, error } = await supabase
      .from('products')
      .insert([{ name, description, price, image_url: imageUrl, category, brand, stock_count }])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/products/:id', authenticateToken, upload.single('image'), async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can update products' });
  }

  const { id } = req.params;
  try {
    const { name, description, price, category, brand, stock_count } = req.body;
    const updates = { name, description, price, category, brand, stock_count };

    if (req.file) {
      updates.image_url = await uploadImage(req.file);
    }

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Product not found' });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/products/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can delete products' });
  }

  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('products')
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Product not found' });

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





// Helper function to update grand total for user
async function updateGrandTotal(userId) {
  const { data: cartItems, error } = await supabase
    .from('cart_items')
    .select('quantity, products(price)')
    .eq('user_id', userId)
    .neq('quantity', 0)
    .order('id');

  if (error) throw new Error(error.message);

  const grandTotal = cartItems.reduce((sum, item) => {
    return sum + (item.products?.price || 0) * item.quantity;
  }, 0);

  const { error: upsertError } = await supabase
    .from('cart_totals')
    .upsert({ user_id: userId, grand_total: grandTotal });

  if (upsertError) throw new Error(upsertError.message);

  return grandTotal;
}

//  Shopping Cart 
app.get('/cart', authenticateToken, async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from('cart_items')
      .select('*, products(*)')
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });

    const enriched = items.map(item => ({
      ...item,
      total_price: item.products.price * item.quantity
    }));

    const { data: totalData } = await supabase
      .from('cart_totals')
      .select('grand_total')
      .eq('user_id', req.user.id)
      .single();

    res.json({
      items: enriched,
      grand_total: totalData?.grand_total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/cart', authenticateToken, async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity) return res.status(400).json({ error: 'Product ID and quantity are required' });

  try {
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single();

    if (productError || !product) return res.status(404).json({ error: 'Product not found' });
    if (quantity > product.stock_count) {
      return res.status(400).json({ error: `Only ${product.stock_count} items in stock` });
    }

    const { data: cartItem, error } = await supabase
      .from('cart_items')
      .insert([{ user_id: req.user.id, product_id: productId, quantity }])
      .select('*, products(*)')
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const grand_total = await updateGrandTotal(req.user.id);

    res.status(201).json({
      ...cartItem,
      total_price: cartItem.products.price * cartItem.quantity,
      grand_total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/cart/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;
  if (!quantity) return res.status(400).json({ error: 'Quantity is required' });

  try {
    const { data: existingItem, error: fetchError } = await supabase
      .from('cart_items')
      .select('*, products(*)')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !existingItem) return res.status(404).json({ error: 'Cart item not found' });

    if (quantity > existingItem.products.stock_count) {
      return res.status(400).json({ error: `Only ${existingItem.products.stock_count} items in stock` });
    }

    const { data: updatedItem, error } = await supabase
      .from('cart_items')
      .update({ quantity })
      .eq('id', id)
      .select('*, products(*)')
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const grand_total = await updateGrandTotal(req.user.id);

    res.json({
      ...updatedItem,
      total_price: updatedItem.products.price * updatedItem.quantity,
      grand_total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/cart/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: deletedItem, error } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error || !deletedItem) return res.status(404).json({ error: 'Cart item not found' });

    const grand_total = await updateGrandTotal(req.user.id);

    res.json({ message: 'Cart item deleted successfully', grand_total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
