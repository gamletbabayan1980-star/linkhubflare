const fs = require('fs'), path = require('path'), crypto = require('crypto');
const COLS = ['users', 'listings', 'requests', 'orders', 'ledger', 'withdrawals', 'leads', 'drafts', 'suppress', 'audit', 'settings'];
const blank = () => ({ users: [], listings: [], requests: [], orders: [], ledger: [], withdrawals: [], leads: [], drafts: [], suppress: [], audit: [], settings: [], seq: 0 });
const mkId = d => p => p + (++d.seq).toString(36) + crypto.randomBytes(3).toString('hex');

exports.open = file => {
  let d = blank();
  if (file && fs.existsSync(file)) d = { ...blank(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const save = () => { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(d)); fs.renameSync(file + '.tmp', file); };
  return { d, save, id: mkId(d), kind: file ? 'file' : 'memory', flush: async () => {}, close: async () => {}, status: () => ({ kind: file ? 'file' : 'memory', error: null }) };
};

exports.openStore = async (o = {}) => {
  return exports.open(o.file ?? (process.env.DB_FILE || 'data/db.json'));
};
