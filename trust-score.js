/**
 * Trust Score 0–100 для площадок продавцов.
 *
 * Компоненты (веса):
 *  1. Domain quality      15%  — эвристики имени, TLD, запрещённые темы
 *  2. Ownership           10%  — подтверждено ли владение
 *  3. Traffic             30%  — органический трафик, тренд, стабильность
 *  4. Authority           20%  — DR/DA / рейтинг домена
 *  5. Spam & risk         15%  — спам-сигналы, Safe Browsing, PBN-признаки
 *  6. Content & index     10%  — индексируемость, тематическое соответствие
 *
 * Итог:
 *   < 50  → rejected
 *   50–69 → review (ручная модерация)
 *   ≥ 70  → approved (если ownership + нет критичных флагов)
 */

'use strict';

const WEIGHTS = {
  domain: 0.15,
  ownership: 0.10,
  traffic: 0.30,
  authority: 0.20,
  spam: 0.15,
  content: 0.10
};

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Базовая оценка домена (без внешних API) */
function scoreDomain(domain, heuristics) {
  if (!heuristics) return { score: 50, flags: ['no_heuristics'] };
  if (heuristics.score === 0 && heuristics.flags?.includes('prohibited_topic')) {
    return { score: 0, flags: heuristics.flags, critical: true };
  }
  return { score: heuristics.score, flags: heuristics.flags || [] };
}

/** Ownership: 100 если подтверждено, 0 если нет */
function scoreOwnership(ownershipVerified) {
  return { score: ownershipVerified ? 100 : 0, flags: ownershipVerified ? [] : ['ownership_unverified'] };
}

/**
 * Трафик (0–100).
 * Ожидает данные провайдера:
 *   organicTraffic (число/мес), trafficTrend (-1..+1), trafficStability (0–1), geoRelevance (0–1)
 */
function scoreTraffic(data = {}) {
  const flags = [];
  let score = 40; // базовый нейтральный

  const traffic = Number(data.organicTraffic) || 0;
  if (traffic <= 0) {
    flags.push('no_traffic_data');
    return { score: 25, flags };
  }

  // Логарифмическая шкала трафика
  // 100 → ~30, 1k → ~50, 10k → ~70, 100k → ~85, 1M → ~95
  const logScore = Math.min(95, 20 + Math.log10(Math.max(1, traffic)) * 18);
  score = logScore;

  // Тренд
  const trend = Number(data.trafficTrend) || 0;
  if (trend > 0.15) { score += 8; flags.push('traffic_growing'); }
  else if (trend < -0.25) { score -= 15; flags.push('traffic_declining'); }
  else if (trend < -0.1) { score -= 6; flags.push('traffic_soft_decline'); }

  // Стабильность
  const stab = Number(data.trafficStability);
  if (!Number.isNaN(stab)) {
    if (stab < 0.4) { score -= 12; flags.push('traffic_volatile'); }
    else if (stab > 0.8) { score += 5; }
  }

  // Резкие скачки (подозрение на накрутку)
  if (data.trafficSpike) { score -= 20; flags.push('traffic_spike'); }

  return { score: clamp(score), flags, raw: { organicTraffic: traffic, trend, stability: stab } };
}

/**
 * Authority / DR-like (0–100)
 * data.dr или data.domainRating 0–100
 */
function scoreAuthority(data = {}) {
  const flags = [];
  const dr = Number(data.dr ?? data.domainRating ?? data.da);
  if (Number.isNaN(dr) || dr < 0) {
    flags.push('no_authority_data');
    return { score: 40, flags };
  }
  // DR уже примерно 0–100
  let score = clamp(dr);
  if (dr < 10) flags.push('very_low_dr');
  else if (dr >= 50) flags.push('strong_dr');
  return { score, flags, raw: { dr } };
}

/**
 * Spam & risk (высокий score = чисто)
 */
function scoreSpam(data = {}, heuristicsFlags = []) {
  const flags = [...(heuristicsFlags || [])];
  let score = 85;

  if (data.spamScore != null) {
    // spamScore 0–100, где 100 = очень спамный
    const spam = Number(data.spamScore);
    score = clamp(100 - spam);
    if (spam >= 60) flags.push('high_spam_score');
    else if (spam >= 30) flags.push('moderate_spam');
  }

  if (data.safeBrowsing === false || data.malware) {
    score = Math.min(score, 10);
    flags.push('safe_browsing_fail');
  }
  if (data.pbnSuspected) { score -= 25; flags.push('pbn_suspected'); }
  if (data.outboundLinksExcess) { score -= 15; flags.push('excessive_outlinks'); }
  if (data.hiddenText) { score -= 20; flags.push('hidden_text'); }
  if (data.domainAgeYears != null && data.domainAgeYears < 0.5) {
    score -= 10; flags.push('very_young_domain');
  }

  return { score: clamp(score), flags };
}

/**
 * Content & indexability
 */
function scoreContent(data = {}) {
  const flags = [];
  let score = 60;

  if (data.indexed === false) { score = 15; flags.push('not_indexed'); }
  else if (data.indexed === true) { score += 15; }

  if (data.topicalRelevance != null) {
    const rel = Number(data.topicalRelevance); // 0–1
    score = score * 0.5 + rel * 100 * 0.5;
    if (rel < 0.3) flags.push('low_topical_relevance');
  }

  if (data.thinContent) { score -= 20; flags.push('thin_content'); }

  return { score: clamp(score), flags };
}

/**
 * Собирает итоговый trust score 0–100
 * @param {object} input
 * @param {string} input.domain
 * @param {boolean} input.ownershipVerified
 * @param {object} input.heuristics  — результат exports.heuristics
 * @param {object} input.provider    — данные от Ahrefs/Semrush/etc
 */
function calculateTrustScore(input = {}) {
  const domainPart = scoreDomain(input.domain, input.heuristics);
  if (domainPart.critical) {
    return {
      score: 0,
      status: 'rejected',
      components: { domain: domainPart },
      flags: domainPart.flags,
      critical: true
    };
  }

  const ownershipPart = scoreOwnership(!!input.ownershipVerified);
  const trafficPart = scoreTraffic(input.provider);
  const authorityPart = scoreAuthority(input.provider);
  const spamPart = scoreSpam(input.provider, domainPart.flags);
  const contentPart = scoreContent(input.provider);

  const components = {
    domain: domainPart,
    ownership: ownershipPart,
    traffic: trafficPart,
    authority: authorityPart,
    spam: spamPart,
    content: contentPart
  };

  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (components[key]?.score ?? 50) * weight;
  }
  total = clamp(total);

  const allFlags = [
    ...domainPart.flags,
    ...ownershipPart.flags,
    ...trafficPart.flags,
    ...authorityPart.flags,
    ...spamPart.flags,
    ...contentPart.flags
  ];

  // Критичные флаги и слабый домен принудительно снижают статус
  const criticalFlags = ['safe_browsing_fail', 'prohibited_topic', 'ownership_unverified'];
  const hasCritical = criticalFlags.some(f => allFlags.includes(f));
  const domainScore = domainPart.score ?? 100;
  const weakDomain = domainScore < 50;

  let status;
  if (total < 50 || hasCritical || domainScore < 50) status = 'rejected';
  else if (total < 70 || allFlags.includes('no_traffic_data') || allFlags.includes('no_authority_data')) status = 'review';
  else status = 'approved';

  return {
    score: total,
    status,
    components,
    flags: [...new Set(allFlags)],
    weights: WEIGHTS,
    calculatedAt: Date.now()
  };
}

module.exports = {
  WEIGHTS,
  calculateTrustScore,
  scoreDomain,
  scoreOwnership,
  scoreTraffic,
  scoreAuthority,
  scoreSpam,
  scoreContent
};
