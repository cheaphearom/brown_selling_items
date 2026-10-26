const { getPool } = require('../lib/db');
const { json } = require('../lib/http');
const { validateCredentials, fingerprint } = require('../lib/loyalty');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const data = req.body || {};
  const name = String(data.name || '').trim(), phone = String(data.phone || '').trim();
  const credentials = validateCredentials(data.card_number, data.serial_number);
  if (!credentials) return json(res, 400, { error: 'Card number and serial number are required.' });
  const loyalty = '•••• ' + credentials.card.slice(-4);
  const ref = String(data.ref || '').trim();
  const incoming = data.items;
  if (!name || name.length > 60 || phone.length > 20 || (!phone && !loyalty) || !/^[a-f0-9-]{8,64}$/i.test(ref) || !Array.isArray(incoming) || incoming.length !== 1) {
    return json(res, 400, { error: 'Invalid order details.' });
  }
  const quantities = new Map();
  for (const item of incoming) {
    const id = String(item.id_menu || ''); const qty = Number(item.qty);
    if (!id || id.length > 100 || !Number.isInteger(qty) || qty !== 1) return json(res, 400, { error: 'Invalid item or quantity.' });
    quantities.set(id, (quantities.get(id) || 0) + qty);
  }
  if (quantities.size !== 1) return json(res, 400, { error: 'Exactly one item per order is allowed.' });
  let client;
  try { client = await getPool().connect(); }
  catch (e) { console.error('order database', e); return json(res, 500, { error: 'Order service unavailable.' }); }
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM shop_orders WHERE ref = $1', [ref]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return json(res, 200, { order: format(existing.rows[0]), duplicate: true }); }
    const loyaltyKey = fingerprint(credentials.card, credentials.serial);
    const used = await client.query('SELECT 1 FROM shop_orders WHERE loyalty_key = $1 LIMIT 1', [loyaltyKey]);
    if (used.rowCount) { await client.query('ROLLBACK'); return json(res, 409, { error: 'This card number and serial number have already been used to place an order.' }); }
    const ids = [...quantities.keys()].sort();
    const records = await client.query('SELECT id_menu, payload, stock FROM products WHERE id_menu = ANY($1::text[]) ORDER BY id_menu FOR UPDATE', [ids]);
    if (records.rowCount !== ids.length) { await client.query('ROLLBACK'); return json(res, 409, { error: 'Some items are no longer available. Refresh the menu.' }); }
    const lines = []; let cents = 0;
    for (const p of records.rows) {
      const qty = quantities.get(p.id_menu);
      if (p.stock < qty || Number(p.payload.status) === 0 || (p.payload.deleted_date && !String(p.payload.deleted_date).startsWith('1900'))) {
        await client.query('ROLLBACK'); return json(res, 409, { error: `${p.payload.menu_name || 'Item'} does not have enough stock. Please refresh.` });
      }
      const base = Math.round(Number(p.payload.menu_price) * 100);
      const discount = Math.min(100, Math.max(0, Number(p.payload.menu_discount) || 0));
      if (!Number.isSafeInteger(base) || base < 0) throw new Error('Invalid configured price');
      const unitCents = Math.round(base * (100 - discount) / 100);
      lines.push({ id_menu: p.id_menu, name: p.payload.menu_name, qty, unit: unitCents / 100, total: unitCents * qty / 100 });
      cents += unitCents * qty;
      await client.query('UPDATE products SET stock=stock-$1, updated_at=now() WHERE id_menu=$2', [qty, p.id_menu]);
    }
    await client.query('INSERT INTO shop_orders(ref, customer_name, phone, loyalty, items, total_cents, loyalty_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [ref, name, phone, loyalty, JSON.stringify(lines), cents, loyaltyKey]);
    await client.query('COMMIT');
    return json(res, 201, { order: { ref, at: Date.now(), name, phone, loyalty, items: lines, total: cents / 100 } });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.code === '23505' && e.constraint === 'shop_orders_loyalty_key_unique') return json(res, 409, { error: 'This card number and serial number have already been used to place an order.' });
    console.error('order', e);
    return json(res, 500, { error: 'Order could not be saved. Please retry.' });
  } finally { client.release(); }
};
function format(row) { return { ref: row.ref, at: new Date(row.created_at).getTime(), name: row.customer_name, phone: row.phone, loyalty: row.loyalty, items: row.items, total: row.total_cents / 100 }; }
