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
import fetch from 'node-fetch';
import axios from 'axios';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
app.use((req, res, next) => {
  if (req.originalUrl === '/payments/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));
app.use(cors());



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

//  REGISTER 
app.post('/register', upload.single('image'), async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields are required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    let imageUrl = null;

    if (req.file) {
      imageUrl = await uploadImage(req.file);
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([{ email, password: hashedPassword, name, profile_image_url: imageUrl }])
      .select()
      .single();

    if (userError) return res.status(400).json({ error: userError.message });

    await supabase.from('carts').insert([{ user_id: user.id, grand_total: 0 }]);

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LOGIN 
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

// GET PROFILE
app.get('/auth/profile', authenticateToken, async (req, res) => {
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
});

// UPDATE PROFILE 
app.put('/auth/profile', authenticateToken, upload.single('image'), async (req, res) => {
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


// Cart Management

// Helper functions
async function getOrCreateCart(userId) {
  const { data: cart, error } = await supabase
    .from('carts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle(); // ✅ prevents the "multiple/no rows" error

  if (error) throw new Error(error.message);

  if (cart) return cart;

  const { data: newCart, error: insertError } = await supabase
    .from('carts')
    .insert({ user_id: userId })
    .select()
    .single(); // still okay here since we just inserted one

  if (insertError) throw new Error(insertError.message);
  return newCart;
}

async function updateGrandTotal(userId) {
  try {
    const cart = await getOrCreateCart(userId);
    const { data: items, error } = await supabase
      .from('cart_items')
      .select('quantity, products(price)')
      .eq('cart_id', cart.id);

    if (error) throw error;

    const grandTotal = items.reduce((sum, item) => {
      return sum + item.quantity * item.products.price;
    }, 0);

    await supabase
      .from('carts')
      .update({ grand_total: grandTotal })
      .eq('id', cart.id);

    return grandTotal;
  } catch (err) {
    console.error('Failed to update grand total:', err);
    return 0;
  }
}



app.get('/cart', authenticateToken, async (req, res) => {
  try {
    const cart = await getOrCreateCart(req.user.id);

    const { data: items, error: itemsError } = await supabase
      .from('cart_items')
      .select('*, products(*)')
      .eq('cart_id', cart.id);

    if (itemsError) return res.status(400).json({ error: itemsError.message });

    const enriched = items.map(item => ({
      ...item,
      total_price: item.products.price * item.quantity
    }));

    const { data: totalData, error: totalError } = await supabase
      .from('cart_totals')
      .select('grand_total')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (totalError) return res.status(400).json({ error: totalError.message });

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
    const cart = await getOrCreateCart(req.user.id);

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
      .insert([{ cart_id: cart.id, product_id: productId, quantity }])
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
    const cart = await getOrCreateCart(req.user.id);

    // Disambiguated join
    const { data: existingItem, error: fetchError } = await supabase
      .from('cart_items')
      .select('*, products:product_id(*)')
      .eq('id', id)
      .eq('cart_id', cart.id)
      .maybeSingle();

    if (fetchError) return res.status(400).json({ error: fetchError.message });
    if (!existingItem) return res.status(404).json({ error: 'Cart item not found' });

    if (quantity > existingItem.products.stock_count) {
      return res.status(400).json({ error: `Only ${existingItem.products.stock_count} items in stock` });
    }

    // Update the cart item with the new quantity
    const { data: updatedItem, error: updateError } = await supabase
      .from('cart_items')
      .update({ quantity })
      .eq('id', id)
      .eq('cart_id', cart.id)
      .select('*, products:product_id(*)')
      .single();

    if (updateError) return res.status(400).json({ error: updateError.message });

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
    const cart = await getOrCreateCart(req.user.id);

    const { data: deletedItem, error } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', id)
      .eq('cart_id', cart.id)
      .select()
      .single();

    if (error || !deletedItem) return res.status(404).json({ error: 'Cart item not found' });

    const grand_total = await updateGrandTotal(req.user.id);

    res.json({ message: 'Cart item deleted successfully', grand_total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order Management 
app.post('/orders', authenticateToken, async (req, res) => {
  try {
    const cart = await getOrCreateCart(req.user.id);

    // Get cart items with product details
    const { data: cartItems, error: itemsError } = await supabase
      .from('cart_items')
      .select('quantity, products(*)')
      .eq('cart_id', cart.id);

    if (itemsError || !cartItems.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Calculate total
    const totalAmount = cartItems.reduce((sum, item) => {
      return sum + item.quantity * item.products.price;
    }, 0);

    // Create order with pending status
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: req.user.id,
        total_amount: totalAmount,
        status: 'pending',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }

    // Insert order_items linked to this order
    const orderItemsData = cartItems.map(item => ({
      order_id: order.id,
      product_id: item.products.id,
      quantity: item.quantity,
      price_at_order: item.products.price, // Store price at purchase time
    }));

    const { error: orderItemsError } = await supabase
      .from('order_items')
      .insert(orderItemsData);

    if (orderItemsError) {
      return res.status(500).json({ error: orderItemsError.message });
    }

    // Return order info to frontend, including order ID for payment metadata
    res.status(201).json({
      order_id: order.id,
      total_amount: totalAmount,
      status: order.status,
      email: req.user.email,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, order_items(*, products(*))')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/orders/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, order_items(*, products(*))')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/orders/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: 'Status is required' });

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can update order status' });
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// PAYMENT MANAGEMENT

// PAYMENT INITIATION
app.post('/payments/initiate', authenticateToken, async (req, res) => {
  try {
    const { amount, email, order_id } = req.body;
    if (!amount || !email || !order_id) {
      return res.status(400).json({ error: 'Amount, email, and order_id are required' });
    }

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
        callback_url: 'https://your-frontend-domain.com/payment-success',
        metadata: { order_id },  // pass order_id here
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json(response.data.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// PAYMENT WEBHOOK
app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];

    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (hash !== signature) {
      console.warn('Invalid Paystack webhook signature');
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(req.body.toString());
    const data = event.data;
    const email = data.customer.email;

    // Lookup user by email
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .single();

    if (userError || !userData) {
      console.warn(`User not found for email: ${email}`);
      return res.status(200).send('User not found');
    }
    const user_id = userData.id;

    // Extract order_id from payment metadata
    const order_id = data.metadata?.order_id;
    if (!order_id) {
      console.warn('No order_id in payment metadata');
      return res.status(400).send('Order ID missing');
    }

    // Setup nodemailer transporter (you can move this outside the handler for efficiency)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    if (event.event === 'charge.success') {
      const amount = data.amount / 100;

      // Update order status to 'paid' and record payment reference
      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          payment_reference: data.reference,
        })
        .eq('id', order_id)
        .eq('user_id', user_id)
        .select()
        .single();

      if (updateError || !updatedOrder) {
        console.warn(`Order update failed for order_id: ${order_id}`);
        return res.status(400).send('Order update failed');
      }

      // Insert payment reference record
      await supabase.from('payment_references').insert({
        user_id,
        order_id,
        reference: data.reference,
        amount,
        channel: data.channel,
        currency: data.currency,
        status: data.status,
        paid_at: data.paid_at,
      });

      res.sendStatus(200); // respond early to Paystack

      // Send success email asynchronously
      const mailOptions = {
        from: `"Forge & Bolt" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your Order Payment Was Successful',
        html: `
          <div style="font-family: Arial, sans-serif; color: #333">
            <h2 style="color: #4CAF50;">✅ Payment Confirmed</h2>
            <p>Hi there,</p>
            <p>We've successfully received your payment of <strong>₦${amount}</strong>.</p>
            <h3>Order Summary</h3>
            <ul>
              <li><strong>Order ID:</strong> ${order_id}</li>
              <li><strong>Payment Reference:</strong> ${data.reference}</li>
              <li><strong>Channel:</strong> ${data.channel}</li>
              <li><strong>Status:</strong> ${data.status}</li>
              <li><strong>Date:</strong> ${new Date(data.paid_at).toLocaleString()}</li>
            </ul>
            <p>Thank you for shopping with <strong>Forge & Bolt</strong>!</p>
          </div>
        `,
      };

      transporter.sendMail(mailOptions).catch(err =>
        console.error('Error sending confirmation email:', err)
      );

    } else if (event.event === 'charge.failed') {
      const amount = data.amount / 100;

      // Update order status to 'failed'
      await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('id', order_id)
        .eq('user_id', user_id);

      // Insert payment reference record
      await supabase.from('payment_references').insert({
        user_id,
        order_id,
        reference: data.reference,
        amount,
        channel: data.channel,
        currency: data.currency,
        status: data.status,
        paid_at: data.paid_at,
      });

      res.sendStatus(200); // respond early to Paystack

      // Send failure email asynchronously
      const mailOptions = {
        from: `"Forge & Bolt" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Payment Failed - Please Try Again',
        html: `
          <div style="font-family: Arial, sans-serif; color: #333">
            <h2 style="color: #d9534f;">❌ Payment Failed</h2>
            <p>Hi there,</p>
            <p>Unfortunately, your payment of <strong>₦${amount}</strong> was not successful.</p>
            <p>Please try again or contact support if you need assistance.</p>
            <h3>Payment Details</h3>
            <ul>
              <li><strong>Order ID:</strong> ${order_id}</li>
              <li><strong>Payment Reference:</strong> ${data.reference}</li>
              <li><strong>Channel:</strong> ${data.channel}</li>
              <li><strong>Status:</strong> ${data.status}</li>
              <li><strong>Date:</strong> ${new Date(data.paid_at).toLocaleString()}</li>
            </ul>
            <p>Thank you for choosing <strong>Forge & Bolt</strong>.</p>
          </div>
        `,
      };

      transporter.sendMail(mailOptions).catch(err =>
        console.error('Error sending failure email:', err)
      );

    } else {
      // Acknowledge other events
      res.sendStatus(200);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook processing failed');
  }
});

// Admin Function

// GET /admin/users - get all users (admin only)
app.get('/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can access users list' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, profile_image_url, name, role, created_at'); // exclude sensitive fields

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/orders - get all orders (admin only)
app.get('/admin/orders', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can access orders list' });
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*');

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/products/low-stock - get products with low stock (admin only)
app.get('/admin/products/low-stock', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can access low stock products' });
  }

  try {
    const lowStockThreshold = 5; // adjust threshold here

    const { data, error } = await supabase
      .from('products')
      .select('*')
      .lt('stock_count', lowStockThreshold);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
