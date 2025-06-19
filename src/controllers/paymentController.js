import axios from 'axios';
import crypto from 'crypto';
import supabase from '../utils/supabaseClient.js';
import transporter from '../utils/mailer.js';
import dotenv from 'dotenv';
dotenv.config();

export const initiatePayment = async (req, res) => {
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
        callback_url: 'https://forge-bolt-neon.vercel.app/my-order',
        metadata: { order_id },
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
};

export const paystackWebhook = async (req, res) => {
  console.log('Paystack webhook endpoint hit at', new Date().toISOString());
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      return res.status(400).send('Missing signature');
    }
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');
    if (hash !== signature) {
      return res.status(401).send('Invalid signature');
    }
    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch (parseErr) {
      return res.status(400).send('Invalid JSON');
    }
    const data = event.data;
    if (!data) return res.status(400).send('No data in webhook');
    const email = data.customer?.email;
    const order_id = data.metadata?.order_id;
    const amount = data.amount ? data.amount / 100 : 0;
    if (!order_id || !email) {
      return res.status(400).send('Missing order_id or email');
    }
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .single();
    if (userError || !userData) {
      return res.status(200).send('User not found');
    }
    const user_id = userData.id;
    if (event.event === 'charge.success') {
      const { data: orderCheck, error: orderCheckError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', Number(order_id))
        .eq('user_id', user_id)
        .single();
      if (!orderCheck || orderCheckError) {
        return res.status(404).send('Order not found');
      }
      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({ status: 'paid' })
        .eq('id', Number(order_id))
        .eq('user_id', user_id)
        .select()
        .single();
      if (updateError || !updatedOrder) {
        return res.status(400).send('Order update failed');
      }
      const { data: userCart, error: cartError } = await supabase
        .from('carts')
        .select('id')
        .eq('user_id', user_id)
        .single();
      if (userCart && userCart.id) {
        await supabase.from('cart_items').delete().eq('cart_id', userCart.id);
      }
      await supabase.from('cart_totals').update({ grand_total: 0 }).eq('user_id', user_id);
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
      const { data: orderItems } = await supabase
        .from('order_items')
        .select('product_id, quantity')
        .eq('order_id', order_id);
      for (const item of orderItems || []) {
        const { product_id, quantity } = item;
        await supabase
          .from('products')
          .update({ stock_count: supabase.rpc('decrement', { x: quantity }) })
          .eq('id', product_id);
      }
      res.sendStatus(200);
      transporter.sendMail({
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
      }).catch(err => console.error('Error sending success email:', err));
    } else if (event.event === 'charge.failed') {
      await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('id', order_id)
        .eq('user_id', user_id);
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
      res.sendStatus(200);
      transporter.sendMail({
        from: `"Forge & Bolt" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Payment Failed - Please Try Again',
        html: `
          <div style="font-family: Arial, sans-serif; color: #333">
            <h2 style="color: #d9534f;">❌ Payment Failed</h2>
            <p>Hi there,</p>
            <p>Your payment of <strong>₦${amount}</strong> was not successful.</p>
            <p>Please try again or contact support if you need help.</p>
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
      }).catch(err => console.error('Error sending failure email:', err));
    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    res.status(500).send('Webhook processing failed');
  }
};
