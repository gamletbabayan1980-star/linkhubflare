// Хранилище. Два режима, выбираются переменной окружения:
//   DATABASE_URL задан  -> PostgreSQL (любой хостинг/провайдер, обычная строка подключения)
//   иначе               -> файл data/db.json (только для разработки и тестов)
// Работает по принципу «рабочая копия в памяти + атомарная запись изменений»: один экземпляр приложения.
// Реляционная схема (db/schema.sql) — следующий этап; адаптер ниже уже даёт долговечное хранение в PostgreSQL.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const COLS = ['users', 'listings', 'requests', 'orders', 'ledger', 'withdrawals', 'leads', 'drafts', 'suppress', 'audit', 'settings'];
const blank = () => ({ users: [], listings: [], requests: [], orders: [], ledger: [], withdrawals: [], leads: [], drafts: [], suppress: [], audit: [], settings: [], seq: 0 });
const mkId = d => p => p + (++d.seq).toString(36) + crypto.randomBytes(3).toString('hex');

exports.open = file => {                                   // файловый режим
  let d = blank();
  if (file && fs.existsSync(file)) d = { ...blank(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const save = () => { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(d)); fs.renameSync(file + '.tmp', file); };
  return { d, save, id: mkId(d), kind: file ? 'file' : 'memory', flush: async () => {}, close: async () => {}, status: () => ({ kind: file ? 'file' : 'memory', error: null }) };
};

exports.INIT_SQL = 'CREATE TABLE IF NOT EXISTS lhf_records (ord BIGSERIAL, collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))';
exports.UPSERT_SQL = 'INSERT INTO lhf_records (collection, id, data) SELECT a, b, c::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS t(a, b, c) ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()';

exports.openPg = async (url, o = {}) => {                  // режим PostgreSQL
  const pg = o.pg || require('pg');                        // пакет pg ставится командой npm install на сервере
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: o.ssl === 'require' ? { rejectUnauthorized: false } : undefined });
  await pool.query(exports.INIT_SQL);
  const d = blank(), seen = new Map(), key = (c, i) => c + '\u0000' + i;
  for (const r of (await pool.query('SELECT collection, id, data FROM lhf_records ORDER BY ord')).rows) {
    if (r.collection === 'meta') d.seq = r.data.seq || 0; else if (d[r.collection]) d[r.collection].push(r.data);
    seen.set(key(r.collection, r.id), JSON.stringify(r.data));
  }
  let chain = Promise.resolve(), lastError = null;
  const collect = () => { const c = [], i = [], x = [];
    const add = (col, id, obj) => { const s = JSON.stringify(obj); if (seen.get(key(col, id)) !== s) { c.push(col); i.push(id); x.push(s); } };
    for (const col of COLS) for (const r of d[col]) add(col, r.id, r); add('meta', 'seq', { seq: d.seq }); return { c, i, x }; };
  const flush = () => (chain = chain.then(async () => {
    const { c, i, x } = collect(); if (!c.length) { lastError = null; return; }
    const cl = await pool.connect();
    try { await cl.query('BEGIN'); await cl.query(exports.UPSERT_SQL, [c, i, x]); await cl.query('COMMIT'); c.forEach((col, n) => seen.set(key(col, i[n]), x[n])); lastError = null; }
    catch (e) { try { await cl.query('ROLLBACK'); } catch {} lastError = e.message; console.error('[store] write failed, will retry:', e.message); }   // seen не обновлён -> повтор при следующей записи
    finally { cl.release(); }
  }));
  return { d, save: () => { flush(); }, id: mkId(d), kind: 'postgres', flush, status: () => ({ kind: 'postgres', error: lastError }), close: async () => { await flush(); await pool.end(); } };
};

exports.openStore = async (o = {}) => {
  const url = o.databaseUrl ?? process.env.DATABASE_URL;
  if (url) return exports.openPg(url, { ssl: o.ssl ?? process.env.PGSSL, pg: o.pg });
  return exports.open(o.file ?? (process.env.DB_FILE || 'data/db.json'));
};
