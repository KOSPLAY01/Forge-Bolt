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
    return 0;
  }
}

export const getCart = async (req, res) => {
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
};

export const addToCart = async (req, res) => {
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
};

export const updateCartItem = async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;
  if (!quantity) return res.status(400).json({ error: 'Quantity is required' });
  try {
    const cart = await getOrCreateCart(req.user.id);
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
};

export const deleteCartItem = async (req, res) => {
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
};
