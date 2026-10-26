const crypto = require('crypto');
function validateCredentials(card, serial) {
  if (typeof card !== 'string' || typeof serial !== 'string') return null;
  const c = card.trim(), s = serial.trim();
  if (!/^[A-Za-z0-9-]{4,32}$/.test(c) || !/^[A-Za-z0-9-]{2,32}$/.test(s)) return null;
  return { card: c, serial: s };
}
function fingerprint(card, serial) {
  const secret = process.env.LOYALTY_HASH_SECRET;
  if (!secret || secret.length < 32) throw new Error('LOYALTY_HASH_SECRET must be at least 32 characters');
  return crypto.createHmac('sha256', secret).update(JSON.stringify([card, serial])).digest('hex');
}
module.exports = { validateCredentials, fingerprint };
