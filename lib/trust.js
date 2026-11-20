// Trust scoring 0-100
const providers = require('./providers');

function domainScore(domain) {
  if (!domain) return 0;
  let s = 50;
  if (domain.length < 15) s += 10;
  if (!domain.includes('-')) s += 5;
  if (domain.endsWith('.com') || domain.endsWith('.org')) s += 10;
  return Math.min(100, s);
}

async function assess(url) {
  let domain = '';
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { domain = url; }
  const traffic = await providers.getMetrics(domain);
  const components = {
    domain: domainScore(domain),
    ownership: 60,
    traffic: Math.min(100, Math.round((traffic.monthlyVisits || 0) / 500)),
    authority: 55,
    spam: 70,
    content: 65,
  };
  const weights = { domain: 0.15, ownership: 0.10, traffic: 0.30, authority: 0.20, spam: 0.15, content: 0.10 };
  let score = 0;
  for (const k of Object.keys(weights)) score += (components[k] || 0) * weights[k];
  score = Math.min(100, Math.max(0, Math.round(score)));
  let status = 'review';
  if (score < 40 || components.domain < 50) status = 'rejected';
  else if (score >= 70) status = 'approved';
  return { trust: score, status, components, flags: [] };
}

function calculateTrustScore(components) {
  const weights = { domain: 0.15, ownership: 0.10, traffic: 0.30, authority: 0.20, spam: 0.15, content: 0.10 };
  let score = 0;
  for (const k of Object.keys(weights)) score += (components[k] || 0) * weights[k];
  return Math.min(100, Math.max(0, Math.round(score)));
}

module.exports = { assess, calculateTrustScore };
