// Simple link checker helper
function checkRel(html, targetUrl) {
  const re = new RegExp(`<a[^>]+href=["']${targetUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const m = html.match(re);
  if (!m) return { found: false, rel: null };
  const rel = (m[0].match(/rel=["']([^"']+)["']/i) || [])[1] || '';
  return { found: true, rel, sponsored: /sponsored/i.test(rel) };
}

module.exports = { checkRel };
