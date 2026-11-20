// Trust score helpers
const trust = require('./trust');

function statusFromScore(score, domainScore) {
  if (score < 40 || (domainScore != null && domainScore < 50)) return 'rejected';
  if (score >= 70) return 'approved';
  return 'review';
}

function recordHistory(db, domain, components, score) {
  db.metricHistory.push({
    domain,
    score,
    components,
    ts: Date.now(),
  });
  if (db.metricHistory.length > 5000) db.metricHistory.shift();
}

module.exports = { statusFromScore, recordHistory, calculateTrustScore: trust.calculateTrustScore };
