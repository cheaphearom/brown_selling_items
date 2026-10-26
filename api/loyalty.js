const { getPool } = require('../lib/db');
const { json } = require('../lib/http');
const { validateCredentials, fingerprint } = require('../lib/loyalty');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const { card_number, serial_number } = req.body || {};
  const input = validateCredentials(card_number, serial_number);
  if (!input) return json(res, 400, { error: 'Enter a valid card number and serial number.' });
  try {
    const hash = fingerprint(input.card, input.serial);
    const result = await getPool().query('SELECT 1 FROM shop_orders WHERE loyalty_key = $1 LIMIT 1', [hash]);
    if (result.rowCount) return json(res, 409, { error: 'This card number and serial number have already been used to place an order.' });
    return json(res, 200, { available: true, message: 'Card details have not been used for an order. Card authenticity has not been verified.' });
  } catch (e) { console.error('loyalty availability', e); return json(res, 500, { error: 'Could not check the card. Please try again.' }); }
};
