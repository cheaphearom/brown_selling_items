const { getPool } = require('../lib/db');
const { json, admin } = require('../lib/http');

// Must match the STATUSES list in the admin page.
const ORDER_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled'];

module.exports = async (req, res) => {
  if (!admin(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    if (req.method === 'GET') {
      const [p, o] = await Promise.all([
        getPool().query('SELECT id_menu, payload->>\'menu_name\' AS name, stock FROM products ORDER BY name'),
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
