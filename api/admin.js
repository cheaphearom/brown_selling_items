const { getPool } = require('../lib/db');
const { json, admin } = require('../lib/http');

// Must match the STATUSES list in admin.html.
const ORDER_STATUSES = ['pending', 'paid', 'completed', 'cancelled'];

module.exports = async (req, res) => {
  if (!admin(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      const [p, o] = await Promise.all([
        // `payload` is returned whole so the page can find the product image + extra details.
        getPool().query('SELECT id_menu, payload->>\'menu_name\' AS name, payload, stock FROM products ORDER BY name'),
        getPool().query('SELECT ref, customer_name AS name, phone, items, total_cents, status, created_at FROM shop_orders ORDER BY created_at DESC LIMIT 100')
      ]);
      return json(res, 200, { products: p.rows, orders: o.rows });
    }

    if (req.method === 'PATCH') {
      const body = req.body || {};

      // --- Change order status: { ref, status } ---
      if (typeof body.ref === 'string') {
        const { ref, status } = body;
        if (typeof status !== 'string' || !ORDER_STATUSES.includes(status)) {
          return json(res, 400, { error: 'Invalid order status.' });
        }
        const r = await getPool().query(
          'UPDATE shop_orders SET status=$1 WHERE ref=$2 RETURNING ref, status',
          [status, ref]
        );
        if (!r.rowCount) return json(res, 404, { error: 'Order not found.' });
        return json(res, 200, { order: r.rows[0] });
      }

      // --- Edit product name / image: { id_menu, name, image } ---
      if (typeof body.id_menu === 'string' && body.stock === undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const image = typeof body.image === 'string' ? body.image.trim() : '';
        if (!name || name.length > 200) return json(res, 400, { error: 'Product name is required (max 200 characters).' });
        if (image.length > 2000 || (image && !/^(https?:\/\/|\/)/i.test(image))) {
          return json(res, 400, { error: 'Image must be empty, or start with http(s):// or /' });
        }
        // NOTE: `||` needs payload to be JSONB. Image is stored under the key "image".
        const r = await getPool().query(
          `UPDATE products
              SET payload = payload || jsonb_build_object('menu_name', $1::text, 'image', $2::text),
                  updated_at = now()
            WHERE id_menu = $3
        RETURNING id_menu, payload->>'menu_name' AS name, payload, stock`,
          [name, image, body.id_menu]
        );
        if (!r.rowCount) return json(res, 404, { error: 'Product not found.' });
        return json(res, 200, { product: r.rows[0] });
      }

      // --- Update product stock: { id_menu, stock } ---
      const { id_menu, stock } = body;
      if (typeof id_menu !== 'string' || !Number.isSafeInteger(stock) || stock < 0 || stock > 1000000) {
        return json(res, 400, { error: 'Invalid product or stock.' });
      }
      const r = await getPool().query(
        'UPDATE products SET stock=$1, updated_at=now() WHERE id_menu=$2 RETURNING id_menu, stock',
        [stock, id_menu]
      );
      if (!r.rowCount) return json(res, 404, { error: 'Product not found.' });
      return json(res, 200, { product: r.rows[0] });
    }

    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('admin', e);
    return json(res, 500, { error: 'Database request failed.' });
  }
};