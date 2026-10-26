const { getPool } = require('../lib/db');
const { json, admin } = require('../lib/http');
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
      const { id_menu, stock } = req.body || {};
      if (typeof id_menu !== 'string' || !Number.isSafeInteger(stock) || stock < 0 || stock > 1000000) return json(res, 400, { error: 'Invalid product or stock.' });
      const r = await getPool().query('UPDATE products SET stock=$1, updated_at=now() WHERE id_menu=$2 RETURNING id_menu, stock', [stock, id_menu]);
      if (!r.rowCount) return json(res, 404, { error: 'Product not found.' });
      return json(res, 200, { product: r.rows[0] });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) { console.error('admin', e); return json(res, 500, { error: 'Database request failed.' }); }
};
