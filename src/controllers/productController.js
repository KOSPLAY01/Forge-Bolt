import fs from 'fs';
import cloudinary from '../utils/cloudinaryConfig.js';
import supabase from '../utils/supabaseClient.js';

const uploadImage = async (file) => {
  if (!file) return null;
  const result = await cloudinary.uploader.upload(file.path, {
    folder: 'forge_and_bolt',
  });
  fs.unlinkSync(file.path);
  return result.secure_url;
};

export const getProducts = async (req, res) => {
  try {
    const { category, brand, price, page = 1, limit = 18 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;
    let query = supabase
      .from('products')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (category) query = query.eq('category', category);
    if (brand) query = query.eq('brand', brand);
    if (price) query = query.lte('price', parseFloat(price));
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
};

export const getProductById = async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Product not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createProduct = async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add products' });
  }
  try {
    const { name, description, price, category, brand, stock_count } = req.body;
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
};

export const updateProduct = async (req, res) => {
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
};

export const deleteProduct = async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can delete products' });
  }
  const { id } = req.params;
  try {
    await supabase.from('cart_items').delete().eq('product_id', id);
    await supabase.from('order_items').delete().eq('product_id', id);
    const { data, error } = await supabase
      .from('products')
      .delete()
      .eq('id', id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted successfully and removed from all related records.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
