// Payments stub (sandbox mode)
const ENABLED = process.env.PAYMENTS !== 'off';

function charge(order) {
  if (!ENABLED) return { ok: true, mode: 'sandbox', id: 'sandbox_' + Date.now() };
  return { ok: false, error: 'payments_not_configured' };
}

function refund(order) {
  if (!ENABLED) return { ok: true, mode: 'sandbox' };
  return { ok: false, error: 'payments_not_configured' };
}

function payout(order) {
  if (!ENABLED) return { ok: true, mode: 'sandbox' };
  return { ok: false, error: 'payments_not_configured' };
}

module.exports = { charge, refund, payout, ENABLED };
