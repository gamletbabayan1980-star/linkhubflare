const c = require('crypto');
const b64 = b => Buffer.from(b).toString('base64url');
exports.hashPassword = (pw, salt = c.randomBytes(16).toString('hex')) => salt + ':' + c.scryptSync(pw, salt, 64).toString('hex');
exports.verifyPassword = (pw, stored) => {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = c.scryptSync(pw, salt, 64); return a.length === b.length && c.timingSafeEqual(a, b);
};
exports.sign = (secret, payload, ttlSec) => {
  const p = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 }));
  return p + '.' + c.createHmac('sha256', secret).update(p).digest('base64url');
};
exports.verify = (secret, tok) => {
  if (!tok || !tok.includes('.')) return null; const [p, s] = tok.split('.');
  const e = c.createHmac('sha256', secret).update(p).digest('base64url');
  if (s.length !== e.length || !c.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? o : null; } catch { return null; }
};
