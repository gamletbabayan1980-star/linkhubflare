/**
 * Провайдеры внешних метрик.
 * Каждый провайдер: async (domain) => ({ organicTraffic, trafficTrend, dr, spamScore, ... }) | null
 *
 * Сейчас: mock-провайдер для разработки + заготовки под Ahrefs / Semrush.
 * Реальные ключи подключаются через env.
 */

'use strict';

/** Простой детерминированный mock по домену (для тестов и dev без API-ключей) */
function mockProvider(domain) {
  // Простая хеш-функция от домена → стабильные "метрики"
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  const rnd = (min, max) => min + (h % (max - min + 1));

  const traffic = rnd(200, 80000);
  const dr = rnd(8, 72);
  const spam = rnd(1, 45);
  const trend = ((h % 100) - 40) / 100; // -0.4 … 0.6

  return {
    source: 'mock',
    organicTraffic: traffic,
    trafficTrend: trend,
    trafficStability: 0.5 + (h % 50) / 100,
    trafficSpike: false,
    dr,
    domainRating: dr,
    spamScore: spam,
    safeBrowsing: true,
    pbnSuspected: spam > 35 && dr < 20,
    domainAgeYears: 1 + (h % 12),
    indexed: true,
    topicalRelevance: 0.55 + (h % 40) / 100,
    checkedAt: Date.now()
  };
}

/** Заготовка Ahrefs (нужен AHREFS_API_KEY) */
async function ahrefsProvider(domain) {
  const key = process.env.AHREFS_API_KEY;
  if (!key) return null;
  // TODO: реальный вызов Ahrefs API
  // Пример: domain rating, organic traffic, etc.
  return null;
}

/** Заготовка Semrush */
async function semrushProvider(domain) {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return null;
  return null;
}

/**
 * Собирает данные от всех доступных провайдеров.
 * Приоритет: реальные API → mock (только если ALLOW_MOCK_METRICS=1 или не production)
 */
async function fetchProviderData(domain, opts = {}) {
  const results = [];

  for (const p of [ahrefsProvider, semrushProvider]) {
    try {
      const r = await p(domain);
      if (r) results.push(r);
    } catch (e) {
      console.error('[provider]', domain, e.message);
    }
  }

  if (results.length) {
    // Мержим: берём максимум трафика/DR, средний spam и т.д.
    const merged = { source: results.map(r => r.source).join('+'), checkedAt: Date.now() };
    merged.organicTraffic = Math.max(...results.map(r => r.organicTraffic || 0));
    merged.dr = Math.round(results.reduce((s, r) => s + (r.dr || r.domainRating || 0), 0) / results.length);
    merged.domainRating = merged.dr;
    merged.spamScore = Math.round(results.reduce((s, r) => s + (r.spamScore || 0), 0) / results.length);
    merged.trafficTrend = results.reduce((s, r) => s + (r.trafficTrend || 0), 0) / results.length;
    merged.safeBrowsing = results.every(r => r.safeBrowsing !== false);
    return merged;
  }

  // Mock только при явном флаге. Без API-ключей → null → status "review".
  const allowMock = opts.allowMock === true || process.env.ALLOW_MOCK_METRICS === '1';
  if (allowMock) return mockProvider(domain);
  return null;
}

module.exports = { fetchProviderData, mockProvider, ahrefsProvider, semrushProvider };
