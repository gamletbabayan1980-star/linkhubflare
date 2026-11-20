// Metrics providers (mock + stubs)
async function mockTraffic(domain) {
  const hash = domain.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    monthlyVisits: 1000 + (hash % 50000),
    bounceRate: 30 + (hash % 40),
    pagesPerVisit: 1.5 + (hash % 30) / 10,
  };
}

async function getMetrics(domain) {
  if (process.env.ALLOW_MOCK_METRICS !== '0') {
    return { provider: 'mock', ...(await mockTraffic(domain)) };
  }
  return { provider: 'none', monthlyVisits: 0 };
}

module.exports = { getMetrics, mockTraffic };
