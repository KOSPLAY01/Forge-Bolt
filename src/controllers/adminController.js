import supabase from '../utils/supabaseClient.js';

export const getAllUsers = async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can access users list' });
  }
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, profile_image_url, name, role, created_at');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAllOrders = async (req, res) => {
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
};

export const getLowStockProducts = async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can access low stock products' });
  }
  try {
    const lowStockThreshold = 5;
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .lt('stock_count', lowStockThreshold);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
