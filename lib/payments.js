function mkPay(mode) {
  const off = !mode || mode === 'off';
  return {
    charge: async () => off ? { ok: true, mode: 'sandbox' } : { ok: false, error: 'not_configured' },
    refund: async () => off ? { ok: true, mode: 'sandbox' } : { ok: false, error: 'not_configured' },
    payout: async () => off ? { ok: true, mode: 'sandbox' } : { ok: false, error: 'not_configured' },
  };
}

module.exports = mkPay;
