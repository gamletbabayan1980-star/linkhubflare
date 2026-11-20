// Конвейер проверки площадки. Внешние метрики (трафик, спам-сети) подключаются через providers.
const dns = require('dns').promises;
const BAD_WORDS = /(casino|porn|xxx|viagra|bet|loan|pills|escort)/i, BAD_TLD = /\.(xyz|top|click|gq|tk|ml|cf|ga|work|loan)$/i;
exports.normalizeDomain = s => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
exports.validDomain = d => /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/.test(d);
exports.heuristics = domain => {            // дешёвая базовая оценка по самому домену
  if (BAD_WORDS.test(domain)) return { score: 0, flags: ['prohibited_topic'] };
  const name = domain.split('.').slice(0, -1).join('.'), flags = []; let s = 80;
  if (name.length > 25) { s -= 15; flags.push('long'); }
  if ((name.match(/\d/g) || []).length / name.length > 0.3) { s -= 25; flags.push('digits'); }
  if ((name.match(/-/g) || []).length >= 2) { s -= 10; flags.push('hyphens'); }
  if (BAD_TLD.test(domain)) { s -= 20; flags.push('risky_tld'); }
  return { score: Math.max(0, s), flags };
};
exports.checkOwnership = async (domain, token, resolveTxt = dns.resolveTxt) => {
  try { const rec = (await resolveTxt('_linkhubflare.' + domain)).flat(); return rec.includes('lhf-verify=' + token); } catch { return false; }
};
// Полная оценка 0–100 через trust-score + providers
const { calculateTrustScore } = require('./trust-score');
const { fetchProviderData } = require('./providers');

/**
 * Главная точка оценки площадки.
 * Второй аргумент может быть:
 *  - массивом старых provider-функций (обратная совместимость)
 *  - объектом { ownershipVerified, allowMock, providers }
 */
exports.assess = async (domain, opts = {}) => {
  const isLegacyArray = Array.isArray(opts);
  const ownershipVerified = isLegacyArray ? false : !!opts.ownershipVerified;
  const allowMock = isLegacyArray ? true : opts.allowMock;
  const legacyProviders = isLegacyArray ? opts : (opts.providers || []);

  const heuristics = exports.heuristics(domain);

  let providerData = null;
  try {
    providerData = await fetchProviderData(domain, { allowMock });
  } catch (e) {
    console.error('[assess] provider error', domain, e.message);
  }

  for (const p of legacyProviders) {
    try {
      const r = await p(domain);
      if (r) providerData = { ...(providerData || {}), ...r, source: ((providerData && providerData.source) || '') + '+legacy' };
    } catch {}
  }

  const result = calculateTrustScore({
    domain,
    ownershipVerified,
    heuristics,
    provider: providerData || {}
  });

  return {
    score: result.score,
    status: result.status,
    flags: result.flags,
    components: result.components,
    provider: providerData,
    needsExternal: !providerData,
    calculatedAt: result.calculatedAt,
    critical: !!result.critical
  };
};
// Нормализация URL для сравнения ссылок
function normalizeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    // убираем trailing slash, приводим host к lower, игнорируем hash
    let path = url.pathname.replace(/\/$/, '') || '';
    return (url.protocol + '//' + url.host.toLowerCase() + path + url.search).toLowerCase();
  } catch {
    return String(u || '').trim().toLowerCase().replace(/\/$/, '');
  }
}

// Проверка, что ссылка не спрятана простыми способами
function isProbablyHidden(tag) {
  const style = ((tag.match(/style\s*=\s*["']([^"']+)["']/i) || [])[1] || '').toLowerCase();
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0|height\s*:\s*0|width\s*:\s*0/.test(style)) return true;
  const cls = ((tag.match(/class\s*=\s*["']([^"']+)["']/i) || [])[1] || '').toLowerCase();
  if (/\b(hidden|sr-only|visually-hidden|d-none|hide)\b/.test(cls)) return true;
  return false;
}

/**
 * Проверка живой ссылки на странице.
 * Требования:
 *  - страница отдаёт 200
 *  - есть <a href="..."> на targetUrl (с нормализацией)
 *  - у ссылки есть rel, содержащий "sponsored"
 *  - ссылка не выглядит скрытой
 * Возвращает подробный результат для отладки и админки.
 */
exports.verifyLink = async (pageUrl, targetUrl, fetchFn = fetch) => {
  const targetNorm = normalizeUrl(targetUrl);
  if (!targetNorm) return { ok: false, reason: 'invalid_target' };

  let res, html;
  try {
    res = await fetchFn(pageUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'LinkHubFlare-LinkChecker/1.0' },
      signal: AbortSignal.timeout(12000)
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: e.message || 'fetch failed' };
  }

  if (res.status !== 200) {
    return { ok: false, reason: 'http_' + res.status, finalUrl: res.url };
  }

  try {
    html = await res.text();
  } catch {
    return { ok: false, reason: 'read_error' };
  }

  // Ищем все <a ...>
  const anchors = [...html.matchAll(/<a\s([^>]*?)>/gi)];
  let foundHref = null;
  let foundRel = null;
  let foundHidden = false;
  let candidateCount = 0;

  for (const m of anchors) {
    const attrs = m[1] || '';
    const hrefMatch = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    // Резолвим относительные ссылки относительно pageUrl
    let absolute;
    try { absolute = new URL(href, pageUrl).href; } catch { continue; }
    const hrefNorm = normalizeUrl(absolute);

    // Считаем совпадением, если нормализованные URL равны
    // или target является префиксом (на случай лишних utm у продавца — пока строгое равенство)
    if (hrefNorm === targetNorm) {
      candidateCount++;
      const relMatch = attrs.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const relRaw = (relMatch ? (relMatch[1] || relMatch[2] || relMatch[3] || '') : '').toLowerCase();
      const relTokens = relRaw.split(/[\s,]+/).filter(Boolean);

      foundHref = absolute;
      foundRel = relRaw || null;
      foundHidden = isProbablyHidden(m[0]);

      if (foundHidden) {
        // продолжаем искать — вдруг есть другая открытая ссылка
        continue;
      }

      if (relTokens.includes('sponsored')) {
        return {
          ok: true,
          href: absolute,
          rel: relRaw,
          finalUrl: res.url,
          status: res.status
        };
      }

      // Нашли ссылку, но без sponsored — запоминаем и продолжаем (может быть другая)
    }
  }

  if (foundHref && foundHidden) {
    return { ok: false, reason: 'link_hidden', href: foundHref, rel: foundRel, finalUrl: res.url };
  }
  if (foundHref) {
    return { ok: false, reason: 'rel_sponsored_missing', href: foundHref, rel: foundRel, finalUrl: res.url };
  }
  return { ok: false, reason: 'link_not_found', finalUrl: res.url, candidatesChecked: anchors.length };
};
