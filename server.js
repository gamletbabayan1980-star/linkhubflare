'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { open, openStore } = require('./lib/store'), A = require('./lib/auth'), T = require('./lib/trust'), mkPay = require('./lib/payments');
// matching логика теперь встроена в runMatching (поддержка нескольких ссылок на один сайт при разных targetUrl)
const CATS = ['automotive', 'business', 'technology', 'home', 'marketing', 'travel', 'finance', 'health', 'education', 'other'];
const PAID = ['paid', 'published', 'verified', 'payout', 'dispute'];
const E = (s, m) => Object.assign(new Error(m), { status: s });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };

function createApp(o = {}) {
  const prod = process.env.NODE_ENV === 'production';
  const secret = o.secret || process.env.SESSION_SECRET || (prod ? null : crypto.randomBytes(32).toString('hex'));
  const adminHash = o.adminHash || process.env.ADMIN_CODE_HASH || (prod ? null : A.hashPassword('ERINMAR'));
  if (!secret || !adminHash) throw new Error('Set SESSION_SECRET and ADMIN_CODE_HASH in production');
  if (!prod && !process.env.ADMIN_CODE_HASH && !o.adminHash) console.warn('[dev] admin code ERINMAR is active — set ADMIN_CODE_HASH before deploy');
  const db = o.store || open(o.file === undefined ? (process.env.DB_FILE || 'data/db.json') : o.file), D = db.d;
  D.withdrawals ||= [];
  D.metricHistory ||= [];   // история метрик для графиков: { id, listingId, domain, at, score, components, provider }
  D.notifications ||= [];   // in-app уведомления: { id, to, role, title, body, kind, orderId, read, at }
  D.settings ||= [];
  const notifSettings = () => {
    const s = (D.settings[0] ||= { id: 'main' });
    s.notify ||= {
      inAppAdmin: true,
      inAppUsers: true,
      soundAdmin: true,
      telegramEnabled: false,
      telegramBotToken: '',
      telegramChatId: '',
      webhookEnabled: false,
      webhookUrl: ''
    };
    return s.notify;
  };
  // to: userId | 'admin'
  const pushNotif = (to, { title, body, kind, orderId }) => {
    const n = { id: db.id('n'), to, title, body, kind: kind || 'info', orderId: orderId || null, read: false, at: Date.now() };
    D.notifications.push(n);
    // не раздуваем историю
    if (D.notifications.length > 2000) D.notifications.splice(0, D.notifications.length - 2000);
    return n;
  };
  const notifyExternal = async (text) => {
    const ns = notifSettings();
    // Telegram: настройки админки или env
    const tk = (ns.telegramEnabled && ns.telegramBotToken) || process.env.TELEGRAM_BOT_TOKEN;
    const ch = (ns.telegramEnabled && ns.telegramChatId) || process.env.TELEGRAM_ADMIN_CHAT;
    if (tk && ch) {
      try {
        await fetchFn('https://api.telegram.org/bot' + tk + '/sendMessage', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: ch, text: String(text).slice(0, 3500) })
        });
      } catch {}
    }
    // Webhook (Discord/Slack/любой мессенджер через URL)
    if (ns.webhookEnabled && ns.webhookUrl) {
      try {
        await fetchFn(ns.webhookUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: String(text), content: String(text) })
        });
      } catch {}
    }
  };
  const notifyAdmin = async (title, body, extra = {}) => {
    const ns = notifSettings();
    if (ns.inAppAdmin !== false) pushNotif('admin', { title, body, kind: extra.kind || 'admin', orderId: extra.orderId });
    await notifyExternal('🔔 ' + title + (body ? '\n' + body : ''));
    db.save();
  };
  const notifyUser = (userId, title, body, extra = {}) => {
    const ns = notifSettings();
    if (ns.inAppUsers === false) return;
    pushNotif(userId, { title, body, kind: extra.kind || 'user', orderId: extra.orderId });
  };
  const MIN_W = 1000, METHODS = ['bank', 'card', 'usdt', 'paypal'];
  // Правила проверки и удержания (см. docs/SELLER_RULES.md). Для тестов время можно сжимать через o.dayMs.
  const DAY = o.dayMs || 864e5, HOLD = (o.holdDays ?? Number(process.env.HOLD_DAYS ?? 7)) * DAY, PUBLISH_DEADLINE = (o.publishDeadlineDays ?? 5) * DAY, CHECK_WINDOW = (o.checkWindowHours ?? 72) * DAY / 24, MONITOR = [30, 90, 180], RULES_V = 'seller-rules-1';
  const pay = mkPay(o.payments || process.env.PAYMENTS || 'off');
  const demoVerify = o.demoVerify ?? process.env.DEMO_VERIFY === '1';
  const fetchFn = o.fetch || fetch, providers = o.providers || [];
  const hits = new Map();
  const limit = (ip, key, max) => { const k = key + ip, n = hits.get(k) || { c: 0, t: Date.now() }; if (Date.now() - n.t > 9e5) { n.c = 0; n.t = Date.now(); } if (++n.c > max) throw E(429, 'Too many attempts'); hits.set(k, n); };

  // ---------- вспомогательные ----------
  const rating = sid => { const mine = D.orders.filter(x => x.sellerId === sid); const c = mine.filter(x => x.status === 'payout').length, d = mine.filter(x => x.disputed || x.penalty).length; return Math.min(5, Math.max(1, 3.5 + Math.min(1.5, c * .1) - d * .5)); };
  const log = (orderId, kind, amount) => D.ledger.push({ id: db.id('l'), orderId, kind, amount, at: Date.now() });
  const FINISHED = ['payout', 'refunded', 'cancelled', 'link_lost'];
  const activeOrders = id => D.orders.filter(x => x.listingId === id && !FINISHED.includes(x.status));
  const activeCount = id => activeOrders(id).length;
  // Уже есть активный заказ на эту площадку с таким же targetUrl?
  const hasSameTarget = (listingId, targetUrl) => activeOrders(listingId).some(o => o.targetUrl === targetUrl);

  function runMatching() {
    const made = [];
    // Заявки с остатком, от высокой ставки к низкой
    const requests = D.requests.filter(r => r.remaining > 0).sort((a, b) => b.bid - a.bid);

    for (const r of requests) {
      // Площадки, уже использованные в этой заявке (qty должно идти на разные сайты)
      const usedInRequest = new Set(D.orders.filter(x => x.requestId === r.id).map(x => x.listingId));

      while (r.remaining > 0) {
        // Площадка доступна, если:
        // - approved + ownership
        // - не превышен capacity
        // - нет активного заказа с таким же targetUrl  ← главное новое правило
        // - ещё не бралась в этой заявке
        const candidates = D.listings
          .filter(l =>
            l.status === 'approved' &&
            l.ownershipVerified &&
            activeCount(l.id) < (l.capacity || 3) &&
            !hasSameTarget(l.id, r.targetUrl) &&
            !usedInRequest.has(l.id)
          )
          .filter(l =>
            l.ask <= r.bid &&
            (l.trust ?? 0) >= (r.minTrust ?? 70) &&
            (!r.language || l.language === r.language) &&
            (!r.country || !l.country || l.country === r.country) &&
            l.category === r.category
          )
          .sort((a, b) => a.ask - b.ask || (b.trust || 0) - (a.trust || 0));

        const best = candidates[0];
        if (!best) break;

        const o = {
          id: db.id('o'),
          requestId: r.id,
          listingId: best.id,
          buyerId: r.buyerId,
          sellerId: best.sellerId,
          bid: r.bid,
          ask: best.ask,
          spread: r.bid - best.ask,
          status: 'matched',
          targetUrl: r.targetUrl,
          anchor: r.anchor,
          publishedUrl: null,
          createdAt: Date.now()
        };
        r.remaining--;
        D.orders.push(o);
        usedInRequest.add(best.id);
        made.push(o);
        notifyUser(o.buyerId, 'Площадка подобрана', 'Заказ ' + o.id + ' готов к оплате. Статус: matched.', { kind: 'order', orderId: o.id });
        notifyUser(o.sellerId, 'Новый потенциальный заказ', 'Появился matched-заказ на ' + (best.domain || 'ваш сайт') + '. Ждём оплату покупателя.', { kind: 'order', orderId: o.id });
      }
    }
    if (made.length) {
      notifyAdmin('Новые подборы: ' + made.length, made.map(x => x.id).join(', '), { kind: 'match' });
      db.save();
    }
    return made;
  }
  // что видит каждая сторона: только свои цифры + полезные таймеры
  const vBuyer = o => {
    const l = D.listings.find(x => x.id === o.listingId);
    return {
      id: o.id, status: o.status, price: o.bid,
      site: { category: l?.category, language: l?.language, country: l?.country, trust: l?.trust },
      publishedUrl: o.publishedUrl, createdAt: o.createdAt, paidAt: o.paidAt,
      publishDeadline: o.paidAt ? o.paidAt + PUBLISH_DEADLINE : null,
      holdUntil: o.holdUntil, refundReason: o.refundReason, lastCheck: o.lastCheck
    };
  };
  const vSeller = o => {
    const l = D.listings.find(x => x.id === o.listingId);
    return {
      id: o.id, status: o.status, payout: o.ask, domain: l?.domain,
      anchor: PAID.includes(o.status) ? o.anchor : undefined,
      targetUrl: PAID.includes(o.status) ? o.targetUrl : undefined,
      requiredRel: 'sponsored', publishedUrl: o.publishedUrl,
      holdUntil: o.holdUntil, linkLostDay: o.linkLostDay,
      publishDeadline: o.paidAt ? o.paidAt + PUBLISH_DEADLINE : null,
      lastCheck: o.lastCheck
    };
  };
  const vListing = l => ({ id: l.id, domain: l.domain, category: l.category, language: l.language, country: l.country, ask: l.ask, status: l.status, ownershipVerified: l.ownershipVerified, trust: l.trust, flags: l.flags, verify: l.ownershipVerified ? undefined : { host: '_linkhubflare.' + l.domain, txt: 'lhf-verify=' + l.verifyToken } });

  // ---------- проверка ссылок, удержание выплаты, мониторинг ----------
  const penalize = x => { x.penalty = true; const sid = x.sellerId; if (D.orders.filter(z => z.sellerId === sid && z.penalty).length >= 3) D.listings.filter(l => l.sellerId === sid && l.status === 'approved').forEach(l => { l.status = 'hidden'; }); };
  // При PAYMENTS=off платежные вызовы пропускаются — статусы всё равно меняются (нужно для тестирования цикла)
  const safePay = async (fn) => { try { return await fn(); } catch (e) { if (pay.mode === 'off') return { ref: 'skipped-off' }; throw e; } };
  const refundBuyer = async (x, why) => {
    await safePay(() => pay.refund(x));
    x.status = 'refunded'; x.refundReason = why; log(x.id, 'refund', x.bid); penalize(x);
  };
  const payout = async (x, now) => {
    const u = D.users.find(z => z.id === x.sellerId) || {}, owed = u.debt || 0, rec = Math.min(owed, x.ask);
    await safePay(() => pay.release(x));
    u.debt = owed - rec; log(x.id, 'seller_payout', x.ask - rec); if (rec) log(x.id, 'debt_recovered', rec); log(x.id, 'platform_fee', x.spread);
    x.status = 'payout'; x.payoutAt = now; x.monitor = MONITOR.map(day => ({ day, done: false }));
  };
  const clawback = async (x, day) => {      // ссылка исчезла после выплаты: возврат покупателю за счёт платформы, долг продавцу
    await safePay(() => pay.refund(x));
    x.status = 'link_lost'; x.linkLostDay = day; log(x.id, 'clawback_refund', x.bid);
    const u = D.users.find(z => z.id === x.sellerId); if (u) u.debt = (u.debt || 0) + x.ask; penalize(x);
  };
  async function checkOrder(x, now = Date.now()) {
    let res = { ok: null };
    const look = async () => {
      const r = await T.verifyLink(x.publishedUrl, x.targetUrl, fetchFn);
      x.lastCheck = { ...r, at: now };
      return r;
    };
    // Временные сетевые/серверные ошибки не считаем окончательным провалом
    const isTempFail = (r) => r && !r.ok && (r.reason === 'unreachable' || r.reason === 'read_error' || /^http_5\d\d$/.test(r.reason || ''));

    if (x.status === 'paid' && now - x.paidAt > PUBLISH_DEADLINE) {
      await refundBuyer(x, 'not_published');
    } else if (x.status === 'published') {
      res = await look();
      if (res.ok) {
        x.status = 'verified';
        x.holdUntil = now + HOLD;
        notifyUser(x.buyerId, 'Ссылка подтверждена', 'Заказ ' + x.id + ' прошёл проверку.', { kind: 'order', orderId: x.id });
        notifyUser(x.sellerId, 'Ссылка подтверждена', 'Удержание до выплаты по заказу ' + x.id, { kind: 'order', orderId: x.id });
      } else if (!isTempFail(res) && now - x.publishedAt > CHECK_WINDOW) {
        await refundBuyer(x, res.reason);
        notifyUser(x.buyerId, 'Возврат по заказу', 'Заказ ' + x.id + ': ' + (res.reason || 'refund'), { kind: 'order', orderId: x.id });
        notifyUser(x.sellerId, 'Заказ возвращён', 'Заказ ' + x.id + ': ' + (res.reason || 'refund'), { kind: 'order', orderId: x.id });
        notifyAdmin('Refund ' + x.id, res.reason || '', { kind: 'order', orderId: x.id });
      }
      // временная ошибка → просто ждём следующей автопроверки
    } else if (x.status === 'verified' && now >= x.holdUntil) {
      res = await look();
      if (res.ok) await payout(x, now);
      else if (!isTempFail(res)) await refundBuyer(x, 'link_removed_in_hold');
    } else if (x.status === 'payout' && x.monitor) {
      for (const m of x.monitor) {
        if (!m.done && now >= x.payoutAt + m.day * DAY) {
          res = await look();
          m.done = true; m.ok = !!res.ok; m.at = now; m.reason = res.reason || null;
          if (!res.ok && !isTempFail(res)) { await clawback(x, m.day); break; }
        }
      }
    }
    db.save(); return res;
  }
  const runChecks = async (now = Date.now()) => { let n = 0; for (const x of D.orders.filter(z => ['paid', 'published', 'verified', 'payout'].includes(z.status))) { try { await checkOrder(x, now); n++; } catch (e) { console.error('[check]', x.id, e.message); } } return n; };

  // ---------- маршруты ----------
  const R = [], route = (m, p, auth, fn) => R.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });
  const sess = (ctx, role, ttl) => ctx.setCookie(role === 'admin' ? 'lhf_admin' : 'lhf', A.sign(secret, role === 'admin' ? { admin: 1 } : { uid: ctx._uid }, ttl), ttl);
  const needRole = (u, r) => { if (!(u.role === r || u.role === 'both')) throw E(403, 'Role ' + r + ' required'); };
  const login = (ctx, u) => { ctx._uid = u.id; sess(ctx, 'user', 7 * 864e2); return { id: u.id, email: u.email, role: u.role, name: u.name }; };

  route('GET', '/api/health', null, () => ({ ok: !db.status().error, storage: db.status().kind, storageError: db.status().error }));
  route('POST', '/api/register', null, ctx => {
    limit(ctx.ip, 'reg', 10); const { email, password, role = 'buyer', name = '' } = ctx.body;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw E(400, 'Invalid email');
    if (String(password || '').length < 8) throw E(400, 'Password must be at least 8 characters');
    if (!['buyer', 'seller', 'both'].includes(role)) throw E(400, 'Invalid role');
    if (role !== 'buyer' && ctx.body.acceptRules !== true) throw E(400, 'Seller rules must be accepted');
    if (D.users.some(u => u.email === email.toLowerCase())) throw E(409, 'Email already registered');
    const u = { id: db.id('u'), email: email.toLowerCase(), name: String(name).slice(0, 80), role, pw: A.hashPassword(password), createdAt: Date.now(), consent: role !== 'buyer' ? { v: RULES_V, at: Date.now() } : null };
    D.users.push(u); db.save(); return login(ctx, u);
  });
  route('POST', '/api/login', null, ctx => {
    limit(ctx.ip, 'login', 10); const u = D.users.find(x => x.email === String(ctx.body.email || '').toLowerCase());
    if (!u || !A.verifyPassword(String(ctx.body.password || ''), u.pw)) throw E(401, 'Wrong email or password'); return login(ctx, u);
  });
  route('POST', '/api/consent', 'user', ctx => { needRole(ctx.user, 'seller'); if (ctx.body.accept !== true) throw E(400, 'Seller rules must be accepted'); ctx.user.consent = { v: RULES_V, at: Date.now() }; db.save(); return { ok: true }; });
  route('GET', '/api/seller/account', 'user', ctx => ({ debt: ctx.user.debt || 0, consent: !!ctx.user.consent, penalties: D.orders.filter(x => x.sellerId === ctx.user.id && x.penalty).length }));
  route('POST', '/api/logout', null, ctx => { ctx.setCookie('lhf', '', 0); ctx.setCookie('lhf_admin', '', 0); return { ok: true }; });
  route('GET', '/api/me', null, ctx => ctx.user ? { id: ctx.user.id, email: ctx.user.email, role: ctx.user.role, name: ctx.user.name } : { guest: true, admin: !!ctx.admin });

  // продавец
  route('POST', '/api/listings', 'user', ctx => {
    needRole(ctx.user, 'seller'); if (!ctx.user.consent) throw E(403, 'Seller rules must be accepted'); const b = ctx.body, domain = T.normalizeDomain(b.domain);
    if (!T.validDomain(domain)) throw E(400, 'Invalid domain'); if (!CATS.includes(b.category)) throw E(400, 'Invalid category');
    const ask = Math.round(Number(b.ask) * 100); if (!(ask >= 100 && ask <= 1e7)) throw E(400, 'Invalid price');
    if (D.listings.some(l => l.domain === domain)) throw E(409, 'Domain already listed');
    const l = { id: db.id('s'), sellerId: ctx.user.id, domain, category: b.category, language: String(b.language || 'en').slice(0, 5), country: b.country ? String(b.country).slice(0, 2).toUpperCase() : null, ask, capacity: Math.min(10, Math.max(1, Number(b.capacity) || 3)), status: 'pending', ownershipVerified: false, verifyToken: crypto.randomBytes(12).toString('hex'), trust: null, flags: [], createdAt: Date.now() };
    D.listings.push(l); db.save(); return vListing(l);
  });
  route('GET', '/api/listings', 'user', ctx => D.listings.filter(l => l.sellerId === ctx.user.id).map(vListing));
  route('POST', '/api/listings/:id/verify', 'user', async ctx => {
    const l = D.listings.find(x => x.id === ctx.params.id && x.sellerId === ctx.user.id); if (!l) throw E(404, 'Not found');
    if (!demoVerify && !(await T.checkOwnership(l.domain, l.verifyToken, o.resolveTxt))) throw E(422, 'DNS TXT record not found yet');
    l.ownershipVerified = true;
    const a = await T.assess(l.domain, { ownershipVerified: true, allowMock: process.env.ALLOW_MOCK_METRICS === '1', providers });
    l.trust = a.score;
    l.flags = a.flags;
    l.status = a.status;
    l.trustComponents = a.components;
    l.lastAssessedAt = a.calculatedAt;
    // Сохраняем снимок метрик для графиков
    D.metricHistory.push({
      id: db.id('mh'),
      listingId: l.id,
      domain: l.domain,
      at: Date.now(),
      score: a.score,
      status: a.status,
      flags: a.flags,
      components: a.components,
      provider: a.provider ? {
        source: a.provider.source,
        organicTraffic: a.provider.organicTraffic,
        dr: a.provider.dr || a.provider.domainRating,
        spamScore: a.provider.spamScore,
        trafficTrend: a.provider.trafficTrend
      } : null
    });
    db.save();
    if (l.status === 'approved') runMatching();
    return vListing(l);
  });
  route('GET', '/api/seller/orders', 'user', ctx => D.orders.filter(x => x.sellerId === ctx.user.id).map(vSeller));
  route('POST', '/api/orders/:id/published', 'user', ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id && o2.sellerId === ctx.user.id); if (!x) throw E(404, 'Not found');
    if (x.status !== 'paid') throw E(409, 'Order must be paid (escrow) first'); try { new URL(ctx.body.url); } catch { throw E(400, 'Invalid URL'); }
    x.publishedUrl = ctx.body.url; x.status = 'published'; x.publishedAt = Date.now();
    notifyUser(x.buyerId, 'Ссылка опубликована', 'Продавец указал страницу. Можно проверить ссылку.', { kind: 'order', orderId: x.id });
    notifyAdmin('Публикация по заказу ' + x.id, x.publishedUrl, { kind: 'order', orderId: x.id });
    db.save(); return vSeller(x);
  });
  // покупатель
  route('POST', '/api/requests', 'user', ctx => {
    needRole(ctx.user, 'buyer'); const b = ctx.body; try { new URL(b.targetUrl); } catch { throw E(400, 'Invalid target URL'); }
    if (!CATS.includes(b.category)) throw E(400, 'Invalid category'); const bid = Math.round(Number(b.bid) * 100), qty = Math.floor(Number(b.qty || 1));
    if (!(bid >= 100 && bid <= 1e7) || !(qty >= 1 && qty <= 50)) throw E(400, 'Invalid bid or quantity');
    const r = { id: db.id('r'), buyerId: ctx.user.id, targetUrl: b.targetUrl, anchor: String(b.anchor || '').slice(0, 120), category: b.category, language: b.language || 'en', country: b.country || null, bid, qty, remaining: qty, minTrust: Math.min(100, Math.max(50, Number(b.minTrust) || 70)), createdAt: Date.now() };
    D.requests.push(r); db.save(); const m = runMatching().filter(x => x.requestId === r.id).length; return { id: r.id, qty, bid, matchedNow: m };
  });
  route('GET', '/api/requests', 'user', ctx => D.requests.filter(r => r.buyerId === ctx.user.id).map(r => ({ id: r.id, category: r.category, bid: r.bid, qty: r.qty, remaining: r.remaining, targetUrl: r.targetUrl })));
  route('GET', '/api/buyer/orders', 'user', ctx => D.orders.filter(x => x.buyerId === ctx.user.id).map(vBuyer));
  route('POST', '/api/orders/:id/pay', 'user', async ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id && o2.buyerId === ctx.user.id); if (!x) throw E(404, 'Not found'); if (x.status !== 'matched') throw E(409, 'Not payable');
    if (pay.mode === 'off') throw E(501, 'Payments are disabled. Ask admin to mark the order as paid (mark-paid).');
    const h = await pay.hold(x); x.escrowRef = h.ref; x.status = 'paid'; x.paidAt = Date.now(); log(x.id, 'escrow_in', x.bid);
    notifyUser(x.sellerId, 'Заказ оплачен — опубликуйте ссылку', 'Заказ ' + x.id + ' в эскроу. Укажите URL страницы с ссылкой.', { kind: 'order', orderId: x.id });
    notifyUser(x.buyerId, 'Оплата прошла', 'Заказ ' + x.id + ' оплачен. Ждём публикацию продавца.', { kind: 'order', orderId: x.id });
    notifyAdmin('Оплата заказа ' + x.id, 'Сумма покупателя: ' + (x.bid / 100) + ' USD', { kind: 'order', orderId: x.id });
    db.save(); return vBuyer(x);
  });
  route('POST', '/api/orders/:id/verify', 'any', async ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id && (ctx.admin || o2.buyerId === ctx.user?.id || o2.sellerId === ctx.user?.id)); if (!x) throw E(404, 'Not found');
    if (!['published', 'verified'].includes(x.status)) throw E(409, 'Nothing to verify');
    const r = await checkOrder(x, Date.now()); return { ok: r.ok !== false, reason: r.reason, status: x.status, holdUntil: x.holdUntil };
  });
  route('POST', '/api/orders/:id/dispute', 'user', ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id && o2.buyerId === ctx.user.id); if (!x) throw E(404, 'Not found');
    if (!['paid', 'published'].includes(x.status)) throw E(409, 'Cannot dispute'); x.status = 'dispute'; x.disputed = true;
    notifyUser(x.sellerId, 'Открыт спор', 'Покупатель открыл спор по заказу ' + x.id, { kind: 'dispute', orderId: x.id });
    notifyAdmin('Спор по заказу ' + x.id, 'Требуется разбор', { kind: 'dispute', orderId: x.id });
    db.save(); return vBuyer(x);
  });
  // администратор
  route('POST', '/api/admin/login', null, ctx => { limit(ctx.ip, 'adm', 5); if (!A.verifyPassword(String(ctx.body.code || '').trim().toUpperCase(), adminHash)) throw E(401, 'Denied'); sess(ctx, 'admin', 8 * 3600); return { ok: true }; });
  route('GET', '/api/admin/summary', 'admin', () => {
    const by = (arr, k) => arr.reduce((a, x) => (a[x[k]] = (a[x[k]] || 0) + 1, a), {}), sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const paid = D.orders.filter(x => PAID.includes(x.status)), done = D.orders.filter(x => x.status === 'payout');
    return { users: D.users.length, listings: by(D.listings, 'status'), requests: D.requests.length, orders: by(D.orders, 'status'), deals: D.orders.length, spreadPotential: sum(D.orders.filter(x => x.status !== 'refunded'), x => x.spread), spreadInEscrow: sum(paid.filter(x => x.status !== 'payout'), x => x.spread), spreadRealized: sum(done, x => x.spread), turnover: sum(done, x => x.bid), paymentsMode: pay.mode };
  });
  route('GET', '/api/admin/deals', 'admin', () => D.orders.map(x => ({ ...x, domain: D.listings.find(l => l.id === x.listingId)?.domain })));
  route('GET', '/api/admin/listings', 'admin', () => D.listings);
  route('GET', '/api/admin/users', 'admin', () => D.users.map(u => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt })));
  route('POST', '/api/admin/listings/:id/:act', 'admin', ctx => {
    const l = D.listings.find(x => x.id === ctx.params.id); if (!l) throw E(404, 'Not found');
    if (ctx.params.act === 'approve') {
      if (!l.ownershipVerified) throw E(409, 'Ownership not verified');
      if ((l.trust ?? 0) < 50) throw E(409, 'Trust too low');
      if (l.status === 'rejected') throw E(409, 'Cannot approve rejected listing');
      l.status = 'approved';
      // Админ подтвердил качество — поднимаем trust до порога matching, если ещё нет внешних метрик
      if ((l.trust ?? 0) < 70) l.trust = 70;
    }
    else if (ctx.params.act === 'reject') l.status = 'rejected'; else throw E(400, 'Bad action');
    db.save(); if (l.status === 'approved') runMatching(); return l;
  });

  // Пересчитать trust-score площадки (с сохранением в историю)
  route('POST', '/api/admin/listings/:id/reassess', 'admin', async ctx => {
    const l = D.listings.find(x => x.id === ctx.params.id); if (!l) throw E(404, 'Not found');
    const a = await T.assess(l.domain, { ownershipVerified: l.ownershipVerified, allowMock: process.env.ALLOW_MOCK_METRICS === '1', providers });
    l.trust = a.score;
    l.flags = a.flags;
    l.trustComponents = a.components;
    l.lastAssessedAt = a.calculatedAt;
    // Не меняем status автоматически при ручном reassess — админ решает сам
    D.metricHistory.push({
      id: db.id('mh'),
      listingId: l.id,
      domain: l.domain,
      at: Date.now(),
      score: a.score,
      status: a.status,
      flags: a.flags,
      components: a.components,
      provider: a.provider ? {
        source: a.provider.source,
        organicTraffic: a.provider.organicTraffic,
        dr: a.provider.dr || a.provider.domainRating,
        spamScore: a.provider.spamScore,
        trafficTrend: a.provider.trafficTrend
      } : null
    });
    db.save();
    return { listing: l, assessment: a };
  });

  /**
   * История метрик для графиков.
   * GET /api/admin/listings/:id/metrics?range=1d|3d|7d|30d|365d|all
   * Возвращает точки: at, score, traffic, dr, spam, components.*
   */
  route('GET', '/api/admin/listings/:id/metrics', 'admin', ctx => {
    const l = D.listings.find(x => x.id === ctx.params.id); if (!l) throw E(404, 'Not found');
    const range = String((ctx.query && ctx.query.range) || '30d');
    const rangeMs = {
      '1d': 864e5,
      '3d': 3 * 864e5,
      '7d': 7 * 864e5,
      '30d': 30 * 864e5,
      '365d': 365 * 864e5,
      'all': Infinity
    }[range] ?? 30 * 864e5;
    const since = Date.now() - rangeMs;
    const points = D.metricHistory
      .filter(h => h.listingId === l.id && h.at >= since)
      .sort((a, b) => a.at - b.at)
      .map(h => ({
        at: h.at,
        date: new Date(h.at).toISOString(),
        score: h.score,
        status: h.status,
        traffic: h.provider?.organicTraffic ?? null,
        dr: h.provider?.dr ?? null,
        spam: h.provider?.spamScore ?? null,
        trafficTrend: h.provider?.trafficTrend ?? null,
        components: h.components ? {
          domain: h.components.domain?.score,
          ownership: h.components.ownership?.score,
          traffic: h.components.traffic?.score,
          authority: h.components.authority?.score,
          spam: h.components.spam?.score,
          content: h.components.content?.score
        } : null
      }));
    return {
      listingId: l.id,
      domain: l.domain,
      range,
      current: {
        score: l.trust,
        status: l.status,
        flags: l.flags,
        components: l.trustComponents,
        lastAssessedAt: l.lastAssessedAt
      },
      points
    };
  });

  route('POST', '/api/admin/match', 'admin', () => ({ created: runMatching().length }));
  route('POST', '/api/admin/run-checks', 'admin', async () => ({ checked: await runChecks() }));

  // --- Уведомления ---
  route('GET', '/api/notifications', 'any', ctx => {
    const to = ctx.admin ? 'admin' : ctx.user.id;
    const list = D.notifications.filter(n => n.to === to).sort((a, b) => b.at - a.at).slice(0, 50);
    return { items: list, unread: list.filter(n => !n.read).length, soundAdmin: notifSettings().soundAdmin !== false };
  });
  route('POST', '/api/notifications/read', 'any', ctx => {
    const to = ctx.admin ? 'admin' : ctx.user.id;
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : null;
    D.notifications.forEach(n => { if (n.to === to && (!ids || ids.includes(n.id))) n.read = true; });
    db.save();
    return { ok: true };
  });
  route('GET', '/api/admin/notify-settings', 'admin', () => {
    const n = notifSettings();
    // не отдаём полный токен наружу — только маску
    return {
      inAppAdmin: n.inAppAdmin !== false,
      inAppUsers: n.inAppUsers !== false,
      soundAdmin: n.soundAdmin !== false,
      telegramEnabled: !!n.telegramEnabled,
      telegramBotTokenSet: !!(n.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN),
      telegramChatId: n.telegramChatId || process.env.TELEGRAM_ADMIN_CHAT || '',
      webhookEnabled: !!n.webhookEnabled,
      webhookUrl: n.webhookUrl || '',
      envTelegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT)
    };
  });
  route('POST', '/api/admin/notify-settings', 'admin', ctx => {
    const n = notifSettings(), b = ctx.body || {};
    if (typeof b.inAppAdmin === 'boolean') n.inAppAdmin = b.inAppAdmin;
    if (typeof b.inAppUsers === 'boolean') n.inAppUsers = b.inAppUsers;
    if (typeof b.soundAdmin === 'boolean') n.soundAdmin = b.soundAdmin;
    if (typeof b.telegramEnabled === 'boolean') n.telegramEnabled = b.telegramEnabled;
    if (typeof b.telegramBotToken === 'string' && b.telegramBotToken.trim()) n.telegramBotToken = b.telegramBotToken.trim();
    if (typeof b.telegramChatId === 'string') n.telegramChatId = b.telegramChatId.trim();
    if (typeof b.webhookEnabled === 'boolean') n.webhookEnabled = b.webhookEnabled;
    if (typeof b.webhookUrl === 'string') n.webhookUrl = b.webhookUrl.trim();
    db.save();
    return { ok: true, settings: {
      inAppAdmin: n.inAppAdmin, inAppUsers: n.inAppUsers, soundAdmin: n.soundAdmin,
      telegramEnabled: n.telegramEnabled, telegramChatId: n.telegramChatId,
      webhookEnabled: n.webhookEnabled, webhookUrl: n.webhookUrl
    }};
  });
  route('POST', '/api/admin/notify-test', 'admin', async () => {
    await notifyAdmin('Тест уведомления', 'Если вы это видите — канал работает.', { kind: 'test' });
    return { ok: true };
  });
  route('POST', '/api/admin/orders/:id/refund', 'admin', async ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id); if (!x) throw E(404, 'Not found'); if (!PAID.includes(x.status) || x.status === 'payout') throw E(409, 'Cannot refund');
    await safePay(() => pay.refund(x)); x.status = 'refunded'; x.refundReason = 'admin'; log(x.id, 'refund', x.bid); db.save(); return { ok: true };
  });

  // --- Улучшения для работы без реальных платежей (Этап 1) ---
  // Админ может принудительно перевести заказ в paid (для тестирования всего цикла)
  route('POST', '/api/admin/orders/:id/mark-paid', 'admin', async ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id); if (!x) throw E(404, 'Not found');
    if (x.status !== 'matched') throw E(409, 'Only matched orders can be marked paid');
    x.status = 'paid';
    x.paidAt = Date.now();
    x.escrowRef = x.escrowRef || ('manual-' + x.id);
    log(x.id, 'escrow_in', x.bid);
    notifyUser(x.sellerId, 'Заказ оплачен — опубликуйте ссылку', 'Заказ ' + x.id + ' отмечен как paid админом.', { kind: 'order', orderId: x.id });
    notifyUser(x.buyerId, 'Заказ переведён в оплату', 'Заказ ' + x.id + ' в статусе paid.', { kind: 'order', orderId: x.id });
    notifyAdmin('mark-paid: ' + x.id, 'Ручная оплата админом', { kind: 'order', orderId: x.id });
    db.save();
    return { ok: true, order: { id: x.id, status: x.status, paidAt: x.paidAt } };
  });

  // Админ может принудительно подтвердить публикацию (если продавец забыл / для тестов)
  route('POST', '/api/admin/orders/:id/force-published', 'admin', ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id); if (!x) throw E(404, 'Not found');
    if (!['paid', 'matched'].includes(x.status)) throw E(409, 'Invalid status for force-published');
    const url = String(ctx.body?.url || x.publishedUrl || '').trim();
    if (!url) throw E(400, 'url required');
    try { new URL(url); } catch { throw E(400, 'Invalid URL'); }
    x.publishedUrl = url;
    x.status = 'published';
    x.publishedAt = Date.now();
    if (!x.paidAt) { x.paidAt = Date.now(); x.escrowRef = x.escrowRef || ('manual-' + x.id); }
    db.save();
    return { ok: true, order: { id: x.id, status: x.status, publishedUrl: x.publishedUrl } };
  });

  // Админ может принудительно запустить проверку одного заказа и увидеть результат
  route('POST', '/api/admin/orders/:id/check', 'admin', async ctx => {
    const x = D.orders.find(o2 => o2.id === ctx.params.id); if (!x) throw E(404, 'Not found');
    const r = await checkOrder(x, Date.now());
    return { ok: r.ok !== false, reason: r.reason || null, status: x.status, holdUntil: x.holdUntil, lastCheck: x.lastCheck };
  });

  // Свободная проверка любой ссылки (админ): pageUrl + targetUrl
  route('POST', '/api/admin/check-link', 'admin', async ctx => {
    const pageUrl = String(ctx.body.pageUrl || ctx.body.url || '').trim();
    const targetUrl = String(ctx.body.targetUrl || ctx.body.target || '').trim();
    if (!pageUrl) throw E(400, 'pageUrl required');
    if (!targetUrl) throw E(400, 'targetUrl required');
    try { new URL(pageUrl); } catch { throw E(400, 'Invalid pageUrl'); }
    try { new URL(targetUrl); } catch { throw E(400, 'Invalid targetUrl'); }
    const r = await T.verifyLink(pageUrl, targetUrl, fetchFn);
    return {
      ok: !!r.ok,
      reason: r.reason || null,
      href: r.href || null,
      rel: r.rel || null,
      finalUrl: r.finalUrl || null,
      status: r.status || null,
      detail: r.detail || null,
      checkedAt: Date.now()
    };
  });

  // ---------- кошелёк платформы (только администратор) ----------
  const wallet = () => {
    const sum = (a, f) => a.reduce((t, x) => t + f(x), 0), fees = D.ledger.filter(l => ['platform_fee', 'debt_recovered', 'clawback_refund'].includes(l.kind)), sgn = l => l.kind === 'clawback_refund' ? -l.amount : l.amount;
    const earned = sum(fees, sgn), withdrawn = sum(D.withdrawals.filter(w => w.status === 'completed'), w => w.amount), pending = sum(D.withdrawals.filter(w => w.status === 'pending'), w => w.amount);
    const inEscrow = sum(D.orders.filter(x => PAID.includes(x.status) && x.status !== 'payout'), x => x.spread);
    const history = [...fees.map(l => ({ type: l.kind === 'platform_fee' ? 'income' : l.kind === 'debt_recovered' ? 'recovered' : 'clawback', amount: sgn(l), orderId: l.orderId, at: l.at })), ...D.withdrawals.filter(w => w.status !== 'cancelled').map(w => ({ type: 'withdrawal', amount: -w.amount, status: w.status, method: w.method, id: w.id, at: w.createdAt }))].sort((a, b) => b.at - a.at).slice(0, 100);
    return { currency: 'USD', earned, withdrawn, pending, available: earned - withdrawn - pending, inEscrow, minWithdraw: MIN_W, methods: METHODS, withdrawals: [...D.withdrawals].reverse(), history, paymentsMode: pay.mode };
  };
  route('GET', '/api/admin/wallet', 'admin', () => wallet());
  route('POST', '/api/admin/wallet/withdraw', 'admin', async ctx => {
    limit(ctx.ip, 'wd', 5); const b = ctx.body;
    if (!A.verifyPassword(String(b.code || '').trim().toUpperCase(), adminHash)) throw E(401, 'Wrong access code');
    const amount = Math.round(Number(b.amount) * 100); if (!(amount >= MIN_W)) throw E(400, 'Minimum withdrawal is $' + MIN_W / 100);
    if (!METHODS.includes(b.method)) throw E(400, 'Invalid method'); const dest = String(b.destination || '').trim(); if (dest.length < 5 || dest.length > 200) throw E(400, 'Invalid destination');
    if (amount > wallet().available) throw E(409, 'Insufficient balance');
    const w = { id: db.id('w'), amount, method: b.method, destination: dest, status: 'pending', createdAt: Date.now() };
    D.withdrawals.push(w);
    if (pay.mode === 'sandbox') { const r = await pay.payout(w); w.status = 'completed'; w.ref = r.ref; w.completedAt = Date.now(); }   // off: ручная выплата, админ подтверждает ниже
    db.save(); return { withdrawal: w, wallet: wallet() };
  });
  route('POST', '/api/admin/wallet/withdrawals/:id/:act', 'admin', ctx => {
    const w = D.withdrawals.find(x => x.id === ctx.params.id); if (!w) throw E(404, 'Not found'); if (w.status !== 'pending') throw E(409, 'Already processed');
    if (ctx.params.act === 'complete') { w.status = 'completed'; w.ref = String(ctx.body.ref || 'manual').slice(0, 80); w.completedAt = Date.now(); }
    else if (ctx.params.act === 'cancel') w.status = 'cancelled'; else throw E(400, 'Bad action');
    db.save(); return wallet();
  });

  // ---------- помощник по привлечению: готовит ЧЕРНОВИКИ, отправляет человек ----------
  D.leads ||= []; D.drafts ||= []; D.suppress ||= []; D.audit ||= []; D.settings ||= []; D.candidates ||= [];
  const AG = require('./lib/agent'), BASE = o.baseUrl || process.env.BASE_URL || 'http://localhost:8080';
  const CAP = Math.min(20, o.dailyCap ?? Number(process.env.OUTREACH_DAILY_CAP ?? 15));
  const apiKey = o.anthropicKey ?? process.env.ANTHROPIC_API_KEY, model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const SET = () => {
    const s = (D.settings[0] ||= { id: 'main', fromName: '', fromEmail: '', replyTo: '', signature: { name: '', title: '', company: '', address: '' }, legalReviewed: false });
    notifSettings(); // ensure notify block exists
    return s;
  };
  const audit = (kind, detail) => D.audit.push({ id: db.id('a'), kind, detail, at: Date.now() });
  const codeOk = c => A.verifyPassword(String(c || '').trim().toUpperCase(), adminHash);
  const suppressed = em => D.suppress.some(x => (x.email && x.email === em.toLowerCase()) || (x.domain && em.toLowerCase().endsWith('@' + x.domain)));
  const senderOk = () => { const s = SET(); return !!(s.fromName && s.fromEmail && s.signature.name && s.signature.company && s.signature.address); };
  const usedToday = () => D.drafts.filter(d => d.approvedAt && new Date(d.approvedAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const viewD = d => ({ ...d, final: d.text + '\n\n' + d.signature + '\n\n' + d.footer });
  const notify = async text => { await notifyAdmin('Outreach', text, { kind: 'outreach' }); };
  const strOk = (v, a, b) => typeof v === 'string' && v.trim().length >= a && v.trim().length <= b;
  route('GET', '/api/admin/outreach', 'admin', () => { const cnt = a => a.reduce((r, x) => (r[x.status] = (r[x.status] || 0) + 1, r), {}); return { settings: SET(), cap: { used: usedToday(), limit: CAP }, rules: AG.rules(), leads: cnt(D.leads), drafts: cnt(D.drafts), suppressed: D.suppress.length, claude: !!apiKey, telegram: !!process.env.TELEGRAM_BOT_TOKEN }; });
  route('POST', '/api/admin/outreach/settings', 'admin', ctx => {
    limit(ctx.ip, 'wd', 5); const b = ctx.body, g = b.signature || {};
    if (!codeOk(b.code)) throw E(401, 'Wrong access code');
    if (!strOk(b.fromName, 2, 80) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.fromEmail || '') || (b.replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.replyTo))) throw E(400, 'Invalid sender');
    if (!strOk(g.name, 2, 80) || !strOk(g.company, 2, 120) || !strOk(g.address, 5, 200) || String(g.title || '').length > 80) throw E(400, 'Invalid signature');
    const s = SET(), ch = []; if (s.fromEmail !== b.fromEmail.trim()) ch.push('fromEmail: ' + (s.fromEmail || '—') + ' → ' + b.fromEmail.trim());
    if (s.fromName !== b.fromName.trim()) ch.push('fromName'); if (s.signature.company !== g.company.trim() || s.signature.address !== g.address.trim()) ch.push('signature'); if (!!b.legalReviewed !== s.legalReviewed) ch.push('legalReviewed: ' + !!b.legalReviewed);
    Object.assign(s, { fromName: b.fromName.trim(), fromEmail: b.fromEmail.trim(), replyTo: (b.replyTo || '').trim(), legalReviewed: !!b.legalReviewed, signature: { name: g.name.trim(), title: String(g.title || '').trim(), company: g.company.trim(), address: g.address.trim() } });
    audit('settings', ch.join('; ') || 'no changes'); db.save(); return s;
  });
  route('POST', '/api/admin/outreach/leads', 'admin', ctx => {
    const arr = Array.isArray(ctx.body.leads) ? ctx.body.leads.slice(0, 200) : []; const made = [], skipped = [];
    for (const x of arr) {
      try { new URL(x.website); } catch { skipped.push({ company: x.company, why: 'invalid website' }); continue; }
      const email = String(x.email || '').trim().toLowerCase(), country = String(x.country || '').trim().toUpperCase();
      if (!strOk(x.company, 1, 120) || !/^[A-Z]{2}$/.test(country) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped.push({ company: x.company, why: 'invalid fields' }); continue; }
      if (D.leads.some(l => l.email === email)) { skipped.push({ company: x.company, why: 'duplicate' }); continue; }
      const l = { id: db.id('c'), company: x.company.trim(), website: x.website, country, email, contactType: ['corporate', 'individual'].includes(x.contactType) ? x.contactType : 'unknown', source: String(x.source || '').trim().slice(0, 200), kind: x.kind === 'seller' ? 'seller' : 'buyer', status: 'new', createdAt: Date.now() };
      D.leads.push(l); made.push(l.id);
    } db.save(); return { added: made.length, skipped };
  });
  route('GET', '/api/admin/outreach/leads', 'admin', () => D.leads);
  route('GET', '/api/admin/outreach/drafts', 'admin', () => D.drafts.map(viewD));
  route('GET', '/api/admin/outreach/audit', 'admin', () => [...D.audit].reverse().slice(0, 100));
  route('POST', '/api/admin/outreach/leads/:id/draft', 'admin', async ctx => {
    const l = D.leads.find(x => x.id === ctx.params.id); if (!l) throw E(404, 'Not found');
    const g = AG.gate(l); if (!g.ok) { l.status = 'blocked'; l.blockReason = g.reason; db.save(); return { blocked: g.reason }; }
    if (suppressed(l.email)) { l.status = 'blocked'; l.blockReason = 'suppressed'; db.save(); return { blocked: 'suppressed' }; }
    if (!senderOk()) throw E(409, 'Sender profile incomplete'); if (!apiKey) throw E(503, 'ANTHROPIC_API_KEY is not set');
    const text = await AG.siteText(l.website, fetchFn), r = await AG.draft({ lead: l, text, language: l.country === 'FR' ? 'French' : 'English' }, { fetchFn, apiKey, model });
    const s = SET(), link = BASE + '/unsubscribe/?t=' + A.sign(secret, { e: l.email }, 365 * 864e2);
    const d = { id: db.id('d'), leadId: l.id, company: l.company, status: 'draft', to: l.email, from: s.fromEmail, fromName: s.fromName, replyTo: s.replyTo, subject: r.subject, text: r.text, need: r.need, fit: r.fit, warnings: r.warnings, language: r.language, law: g.rule.law, createdAt: Date.now(),
      signature: [s.signature.name, s.signature.title, s.signature.company].filter(Boolean).join('\n'),
      footer: AG.footer(l.country === 'FR' ? 'fr' : l.country === 'NL' ? 'nl' : 'en', { name: s.signature.name, title: s.signature.title, company: s.signature.company, address: s.signature.address, source: l.source, link }) };
    D.drafts.push(d); l.status = 'drafted'; audit('draft', l.company); db.save(); notify('LinkHub Flare: new outreach draft ready for review — ' + l.company + ' (' + l.country + ')'); return viewD(d);
  });
  const getD = (ctx, st) => { const d = D.drafts.find(x => x.id === ctx.params.id); if (!d) throw E(404, 'Not found'); if (st && !st.includes(d.status)) throw E(409, 'Wrong draft status: ' + d.status); return d; };
  route('POST', '/api/admin/outreach/drafts/:id/edit', 'admin', ctx => { const d = getD(ctx, ['draft']); if (!strOk(ctx.body.subject, 3, 150) || !strOk(ctx.body.text, 20, 3000)) throw E(400, 'Invalid text'); d.subject = ctx.body.subject.trim(); d.text = ctx.body.text.trim(); db.save(); return viewD(d); });   // подпись и юр. блок не редактируются
  route('POST', '/api/admin/outreach/drafts/:id/approve', 'admin', ctx => {
    const d = getD(ctx, ['draft']), l = D.leads.find(x => x.id === d.leadId);
    if (!SET().legalReviewed) throw E(409, 'Legal review not confirmed'); if (!senderOk()) throw E(409, 'Sender profile incomplete');
    if (usedToday() >= CAP) throw E(429, 'Daily cap reached'); if (suppressed(d.to)) throw E(409, 'Recipient is suppressed');
    const g = AG.gate(l); if (!g.ok) throw E(409, 'Blocked: ' + g.reason);
    d.status = 'approved'; d.approvedAt = Date.now(); audit('approve', d.company); db.save(); return viewD(d);
  });
  route('POST', '/api/admin/outreach/drafts/:id/reject', 'admin', ctx => { const d = getD(ctx, ['draft', 'approved']); d.status = 'rejected'; audit('reject', d.company); db.save(); return viewD(d); });
  route('POST', '/api/admin/outreach/drafts/:id/sent', 'admin', ctx => { const d = getD(ctx, ['approved']); d.status = 'sent'; d.sentAt = Date.now(); const l = D.leads.find(x => x.id === d.leadId); if (l) l.status = 'contacted'; audit('sent', d.company); db.save(); return viewD(d); });
  route('POST', '/api/admin/outreach/suppress', 'admin', ctx => { const em = String(ctx.body.email || '').trim().toLowerCase(), dm = String(ctx.body.domain || '').trim().toLowerCase(); if (!em && !dm) throw E(400, 'email or domain required'); D.suppress.push({ id: db.id('x'), email: em || null, domain: dm || null, at: Date.now(), source: 'admin' }); audit('suppress', em || dm); db.save(); return { ok: true }; });

  // ---------- Автопоиск кандидатов (продавцы и покупатели) ----------
  const Finder = require('./lib/finder');
  route('POST', '/api/admin/discover', 'admin', async ctx => {
    const b = ctx.body || {};
    const query = String(b.query || '').trim();
    const kind = b.kind === 'buyer' ? 'buyer' : 'seller';
    if (query.length < 2) throw E(400, 'Query required');
    const allowMock = process.env.ALLOW_MOCK_METRICS === '1' || demoVerify;
    const found = await Finder.discover({ query, kind, country: b.country, fetchFn, allowMock });
    // Дедупликация по домену
    const existing = new Set([...D.candidates.map(c => c.domain), ...D.leads.map(l => (l.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])]);
    const added = [];
    for (const c of found) {
      if (existing.has(c.domain)) continue;
      D.candidates.push(c);
      added.push(c);
      existing.add(c.domain);
    }
    db.save();
    notifyAdmin('Найдено кандидатов: ' + added.length, query + ' (' + kind + ')', { kind: 'discover' });
    return { found: found.length, added: added.length, candidates: added };
  });

  route('GET', '/api/admin/candidates', 'admin', () => D.candidates.filter(c => !c.reviewed).sort((a, b) => b.discoveredAt - a.discoveredAt));

  route('POST', '/api/admin/candidates/:id/approve', 'admin', ctx => {
    const c = D.candidates.find(x => x.id === ctx.params.id); if (!c) throw E(404, 'Not found');
    c.reviewed = true;
    // Создаём лид
    const lead = {
      id: db.id('c'),
      company: c.title || c.domain,
      website: c.url || ('https://' + c.domain),
      country: c.country || 'US',
      email: c.email || ('contact@' + c.domain),
      contactType: 'unknown',
      source: 'auto-discover:' + (c.kind || 'seller'),
      kind: c.kind || 'seller',
      status: 'new',
      createdAt: Date.now(),
      domain: c.domain,
      trust: c.trust
    };
    D.leads.push(lead);
    audit('candidate_approve', c.domain);
    db.save();
    return { ok: true, lead };
  });

  route('POST', '/api/admin/candidates/:id/reject', 'admin', ctx => {
    const c = D.candidates.find(x => x.id === ctx.params.id); if (!c) throw E(404, 'Not found');
    c.reviewed = true;
    c.rejected = true;
    audit('candidate_reject', c.domain);
    db.save();
    return { ok: true };
  });

  route('POST', '/api/unsubscribe', null, ctx => {   // публичная отписка по ссылке из письма
    limit(ctx.ip, 'unsub', 30); const p = A.verify(secret, ctx.body.t); if (!p || !p.e) throw E(400, 'Invalid link');
    if (!suppressed(p.e)) D.suppress.push({ id: db.id('x'), email: p.e, domain: null, at: Date.now(), source: 'link' });
    D.drafts.filter(d => d.to === p.e && ['draft', 'approved'].includes(d.status)).forEach(d => { d.status = 'rejected'; }); db.save(); return { ok: true };
  });

  // ---------- HTTP ----------
  const pub = path.join(__dirname, 'public');
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x'), ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    if (!u.pathname.startsWith('/api/')) {
      let f = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname; f = path.normalize(path.join(pub, f));
      if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
    }
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i).trim(), c.slice(i + 1)]; }));
    const sets = []; const tu = A.verify(secret, cookies.lhf), ta = A.verify(secret, cookies.lhf_admin);
    const ctx = { ip, body: {}, params: {}, query: Object.fromEntries(u.searchParams), user: tu && D.users.find(x => x.id === tu.uid), admin: !!(ta && ta.admin), setCookie: (n, v, ttl) => sets.push(`${n}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${prod ? '; Secure' : ''}`) };
    try {
      if (req.method === 'POST') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) throw E(415, 'JSON required');
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) throw E(413, 'Too large'); } try { ctx.body = raw ? JSON.parse(raw) : {}; } catch { throw E(400, 'Bad JSON'); }
      }
      const r = R.find(x => x.m === req.method && x.re.test(u.pathname)); if (!r) throw E(404, 'No such endpoint');
      ctx.params = u.pathname.match(r.re).groups || {};
      if (r.auth === 'user' && !ctx.user) throw E(401, 'Login required'); if (r.auth === 'admin' && !ctx.admin) throw E(401, 'Admin only'); if (r.auth === 'any' && !ctx.user && !ctx.admin) throw E(401, 'Login required');
      const out = await r.fn(ctx); if (sets.length) res.setHeader('Set-Cookie', sets);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) { const s = e.status || 500; if (s === 500) console.error(e); if (sets.length) res.setHeader('Set-Cookie', sets); res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: s === 500 ? 'Server error' : e.message })); }
  }
  return { server: http.createServer(handle), db, runMatching, runChecks };
}
module.exports = { createApp };
if (require.main === module) (async () => {
  const store = await openStore(), app = createApp({ store }), { server } = app, p = process.env.PORT || 8080;
  setInterval(() => app.runChecks().catch(e => console.error('[checks]', e.message)), 10 * 60 * 1000);   // автопроверка ссылок каждые 10 минут
  if (process.env.NODE_ENV === 'production' && store.kind !== 'postgres') console.warn('[warn] production without DATABASE_URL: data is stored in a local file');
  server.listen(p, () => console.log('LinkHub Flare on :' + p + ' · storage: ' + store.kind));
  const stop = async () => { server.close(); await store.close(); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
})();
