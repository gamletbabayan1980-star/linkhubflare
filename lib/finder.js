const https = require('https');
const trust = require('./trust');

function searchDuckDuckGo(query) {
  return new Promise((resolve) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const links = [...data.matchAll(/uddg=([^&"]+)/g)].map((m) => decodeURIComponent(m[1])).slice(0, 8);
        resolve(links.length ? links : []);
      });
    }).on('error', () => resolve([]));
  });
}

function extractEmails(html) {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return [...new Set((html || '').match(re) || [])].slice(0, 5);
}

async function discover(query, type = 'seller') {
  const links = await searchDuckDuckGo(query + (type === 'seller' ? ' write for us' : ' guest post'));
  const results = [];
  for (const url of links.slice(0, 5)) {
    try {
      const assessed = await trust.assess(url);
      results.push({
        url,
        type,
        trust: assessed.trust,
        status: assessed.status,
        flags: assessed.flags || [],
        emails: [],
      });
    } catch (e) {
      results.push({ url, type, trust: 0, status: 'error', flags: [String(e.message || e)], emails: [] });
    }
  }
  return results;
}

module.exports = { discover, searchDuckDuckGo };
