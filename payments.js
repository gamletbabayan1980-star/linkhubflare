// Платёжный слой. Подключается ПОСЛЕДНИМ. off — оплата недоступна; sandbox — имитация эскроу для тестов.
// Для реального запуска: реализовать hold/release/refund через Stripe Connect / Paddle / местных провайдеров + KYC продавцов.
module.exports = (mode = 'off') => {
  const need = () => { if (mode === 'off') throw Object.assign(new Error('Payments are not enabled yet'), { status: 501 }); };
  return { mode,
    async hold(o) { need(); return { ref: 'sandbox-' + o.id }; },
    async release(o) { need(); return { ref: 'payout-' + o.id }; },
    async refund(o) { need(); return { ref: 'refund-' + o.id }; },
    async payout(w) { need(); return { ref: 'sandbox-payout-' + w.id }; } };   // вывод средств платформы
};
