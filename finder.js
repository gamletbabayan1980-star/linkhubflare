/**
 * Автоматический поиск потенциальных продавцов и покупателей.
 * Сначала ищет кандидатов, проверяет базовые метрики, показывает админу.
 * Админ решает: добавить в лиды или отклонить.
 *
 * Поиск: DuckDuckGo HTML (без ключа) + быстрая оценка домена.
 * Для продакшена можно заменить на SerpAPI / Google Custom Search.
 */
'use strict';

const T = require('./trust');

async function searchDuckDuckGo(query, fetchFn = fetch) {
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const r = await fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkHubFlareFinder/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const html = await r.text();
    const results = [];
    // Простой парсинг результатов DuckDuckGo HTML
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < 15) {
      let href = m[1];
      // DDG редиректы
      if (href.includes('uddg=')) {
        try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {}
      }
      try {
        const u = new URL(href);
        if (!u.hostname || u.hostname.includes('duckduckgo') || u.hostname.includes('google')) continue;
        results.push({
          url: u.origin,
          domain: u.hostname.replace(/^www\./, ''),
          title: m[2].replace(/<[^>]+>/g, '').trim().slice(0, 120)
        });
      } catch {}
    }
    return results;
  } catch (e) {
    console.error('[finder] search error', e.message);
    return [];
  }
}

/**
 * Извлечь возможный контактный email с главной страницы (простой regex).
 */
async function extractEmail(domain, fetchFn = fetch) {
  try {
    const r = await fetchFn('https://' + domain, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!r.ok) return null;
    const html = await r.text();
    const emails = [...html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)]
      .map(m => m[0].toLowerCase())
      .filter(e => !e.includes('example') && !e.includes('sentry') && !e.includes('wixpress') && e.length < 60);
    // Предпочитаем корпоративные
    const good = emails.find(e => e.startsWith('hello') || e.startsWith('contact') || e.startsWith('info') || e.startsWith('sales') || e.startsWith('support'));
    return good || emails[0] || null;
  } catch {
    return null;
  }
}

/**
 * Главная функция: поиск + базовая проверка.
 * @param {object} opts
 * @param {string} opts.query - ключевые слова ("tech blogs", "SaaS startups")
 * @param {'seller'|'buyer'} opts.kind
 * @param {string} [opts.country]
 * @param {function} [opts.fetchFn]
 * @returns {Promise<Array>} кандидаты с domain, title, email?, trust?, flags
 */
exports.discover = async ({ query, kind = 'seller', country, fetchFn = fetch, allowMock = false }) => {
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Query too short');

  // Для продавцов ищем сайты/блоги, для покупателей — компании/SaaS
  const searchQuery = kind === 'seller'
    ? q + ' blog OR magazine OR news site'
    : q + ' company OR startup OR SaaS official site';

  let results = await searchDuckDuckGo(searchQuery, fetchFn);

  // Если ничего не нашли и разрешён mock — генерируем примеры
  if (!results.length && allowMock) {
    const base = q.replace(/\s+/g, '-').toLowerCase().slice(0, 20);
    results = [
      { domain: base + '-blog.com', title: q + ' Blog', url: 'https://' + base + '-blog.com' },
      { domain: base + '-media.com', title: q + ' Media', url: 'https://' + base + '-media.com' }
    ];
  }

  const candidates = [];
  for (const r of results.slice(0, 10)) {
    const domain = r.domain;
    if (!domain || domain.length < 4) continue;

    // Быстрая оценка
    let assessment = null;
    try {
      assessment = await T.assess(domain, { ownershipVerified: false, allowMock });
    } catch {}

    const email = await extractEmail(domain, fetchFn);

    candidates.push({
      id: 'c' + Math.random().toString(36).slice(2, 10),
      domain,
      title: r.title || domain,
      url: r.url || ('https://' + domain),
      kind,
      country: country || null,
      email: email || null,
      trust: assessment?.score ?? null,
      status: assessment?.status || 'unknown',
      flags: assessment?.flags || [],
      source: 'auto-discover',
      discoveredAt: Date.now(),
      reviewed: false
    });
  }

  return candidates;
};
