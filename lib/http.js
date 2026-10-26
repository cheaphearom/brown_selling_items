function json(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(data);
}
function admin(req) {
  const token = process.env.ADMIN_TOKEN;
  const presented = req.headers.authorization || '';
  const crypto = require('crypto');
  const expected = 'Bearer ' + token;
  return !!token && Buffer.byteLength(presented) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
module.exports = { json, admin };
