const crypto = require('crypto');
function validateCredentials(card, serial) {
  if (typeof card !== 'string' || typeof serial !== 'string') return null;
  const c = card.trim(), s = serial.trim();
  if (!/^[A-Za-z0-9-]{4,32}$/.test(c) || !/^[A-Za-z0-9-]{2,32}$/.test(s)) return null;
  return { card: c, serial: s };
}
function fingerprint(card) {
  const secret = process.env.LOYALTY_HASH_SECRET;
  if (!secret) {throw new Error('LOYALTY_HASH_SECRET is not configured');}
  return crypto.createHmac('sha256', secret).update('card:' + String(card).trim()).digest('hex');
}
// Identical to fingerprint(), so keep one implementation and alias it
const cardFingerprint = fingerprint;

// Port of PHP GetCardSerial()
function getCardSerial(card) {
  const c = String(card).trim();
  if (!/^\d{2,}$/.test(c)) return null;

  const body = BigInt(c.slice(0, -1));
  const check = BigInt(c.slice(-1));
  const a = body * (check + 1n);

  const hex = a.toString(16);
  const reversed = hex.split('').reverse().join('');
  return reversed.slice(0, 6).toUpperCase();
}

// Compare the serial the user typed against the computed one
function verifySerial(card, serial) {
  const expected = getCardSerial(card);
  if (!expected) return false;
  const given = String(serial).trim().toUpperCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { validateCredentials, fingerprint, cardFingerprint,getCardSerial, verifySerial,};
