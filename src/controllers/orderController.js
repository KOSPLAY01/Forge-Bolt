import supabase from '../utils/supabaseClient.js';

async function getOrCreateCart(userId) {
  const { data: cart, error } = await supabase
    .from('carts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (cart) return cart;
  const { data: newCart, error: insertError } = await supabase
    .from('carts')
    .insert({ user_id: userId })
    .select()
    .single();
  if (insertError) throw new Error(insertError.message);
  return newCart;
}

export const createOrder = async (req, res) => {
  try {
    const cart = await getOrCreateCart(req.user.id);
    const { data: cartItems, error: itemsError } = await supabase
      .from('cart_items')
      .select('quantity, products(*)')
      .eq('cart_id', cart.id);
    if (itemsError || !cartItems.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    const totalAmount = cartItems.reduce((sum, item) => {
      return sum + item.quantity * item.products.price;
    }, 0);
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
    const orderItemsData = cartItems.map(item => ({
      order_id: order.id,
      product_id: item.products.id,
      quantity: item.quantity,
      price_at_order: item.products.price,
    }));
    const { error: orderItemsError } = await supabase
      .from('order_items')
      .insert(orderItemsData);
    if (orderItemsError) {
      return res.status(500).json({ error: orderItemsError.message });
    }
    res.status(201).json({
      order_id: order.id,
      total_amount: totalAmount,
      status: order.status,
      email: req.user.email,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getOrders = async (req, res) => {
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
};

export const getOrderById = async (req, res) => {
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
};

export const updateOrderStatus = async (req, res) => {
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
};

export const getOrderHistory = async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*, order_items(*, products(*))')
      .eq('user_id', req.user.id)
      .eq('status', 'paid')
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
