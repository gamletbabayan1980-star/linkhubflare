// Слепой подбор: продавец получает ask, покупатель платит bid, разница — доход платформы.
// Качество — жёсткий фильтр; затем самая низкая цена продавца; заявки — от самой высокой ставки.
const ok = (l, r) => l.ask <= r.bid && l.trust >= (r.minTrust ?? 70)
  && (!r.language || l.language === r.language) && (!r.country || !l.country || l.country === r.country)
  && l.category === r.category && !(r.exclude && r.exclude.has(l.id));
exports.matchAll = (listings, requests) => {
  const taken = new Set(), deals = [];
  for (const r of requests.flatMap(r => Array.from({ length: r.qty || 1 }, () => r)).sort((a, b) => b.bid - a.bid)) {
    const best = listings.filter(l => !taken.has(l.id) && ok(l, r)).sort((a, b) => a.ask - b.ask || b.trust - a.trust)[0];
    if (!best) continue;
    taken.add(best.id); (r.exclude ||= new Set()).add(best.id);
    deals.push({ requestId: r.id, listingId: best.id, bid: r.bid, ask: best.ask, spread: r.bid - best.ask });
  }
  return deals;
};
