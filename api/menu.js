const { getPool } = require('../lib/db');
const { json } = require('../lib/http');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    const { rows } = await getPool().query('SELECT payload || jsonb_build_object(\'menu_stock\', stock) AS item FROM products ORDER BY (payload->>\'index_number\')::integer NULLS LAST');
    console.log(rows);
    return json(res, 200, { result: { total: rows.length, data: rows.map(r => r.item) } });
  } catch (e) { console.error('menu', e); return json(res, 500, { error: 'Menu unavailable. Database setup may be incomplete.' }); }
};
