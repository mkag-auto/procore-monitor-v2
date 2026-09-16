// api/_procore.js — shared Procore client, sessions, and Redis cache
//
// How data flows:
//   • Opening the app only READS the saved snapshot from Redis (zero Procore calls).
//   • ?sync=true  → incremental sync (only records changed since last sync).
//   • ?force=true → full rebuild (every record, every project).
//   • Everything is cached per company, so switching companies never mixes data.
//   • Date-based fields (flags, days past due) are computed when data is served,
//     so a snapshot from yesterday still shows today's overdue items correctly.
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');  // used only when REDIS_URL isn't set

// Storage: Railway Redis (REDIS_URL) if present, otherwise Upstash REST.
// Both are wrapped so the rest of the app sees the same get/set/del behaviour
// (values stored as JSON, set() supports { ex, nx } and returns 'OK' or null).
function makeStore() {
  if (process.env.REDIS_URL) {
    const IORedis = require('ioredis');
    // family: 0 lets ioredis use Railway's private (IPv6) network
    const client = new IORedis(process.env.REDIS_URL, { family: 0, maxRetriesPerRequest: 3 });
    client.on('error', e => console.warn('[redis] connection error:', e.message));
    console.log('[redis] using Railway Redis (REDIS_URL)');
    return {
      async get(key) {
        const v = await client.get(key);
        if (v == null) return null;
        try { return JSON.parse(v); } catch { return v; }
      },
      async set(key, value, opts = {}) {
        const args = [key, JSON.stringify(value)];
        if (opts.ex) args.push('EX', opts.ex);
        if (opts.nx) args.push('NX');
        return client.set(...args);
      },
      async del(key) { return client.del(key); },
    };
  }
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  if (!url) console.error('[redis] No database configured — add a Redis service and set REDIS_URL');
  return new Redis({
    url,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  });
}
const redis = makeStore();

const API = 'https://api.procore.com';
const LOGIN = 'https://login.procore.com';
const SESSION_COOKIE = 'pm_sid';
const SESSION_TTL_S = 30 * 24 * 3600;          // stay signed in 30 days
const REFRESH_BEFORE_MS = 10 * 60 * 1000;      // refresh token if <10 min left
const PROJECTS_FRESH_MS = 6 * 60 * 60 * 1000;  // project list reused for 6 h
const LOCK_TTL_S = 300;                        // one sync per company+tool at a time
const TZ = process.env.APP_TIMEZONE || 'America/New_York';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// ── Cookies ───────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(c => {
    const [k, ...rest] = c.trim().split('=');
    if (k) list[k.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return list;
}

function setCookie(res, name, value, maxAgeS) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

// ── Redis helpers (fail-safe) ─────────────────────────────────────────────────
async function upGet(key) {
  try { return await redis.get(key); }
  catch (e) { console.warn('[redis] get failed:', key, e.message); return null; }
}
async function upSet(key, value, opts) {
  try { await redis.set(key, value, opts); return true; }
  catch (e) { console.warn('[redis] set failed:', key, e.message); return false; }
}

// Quick read/write test used by /api/setup-check (times out instead of hanging)
async function storeCheck() {
  const key = `healthcheck:${Date.now()}`;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 5 seconds')), 5000));
  try {
    await Promise.race([redis.set(key, { ok: true }, { ex: 60 }), timeout]);
    const v = await Promise.race([redis.get(key), timeout]);
    await redis.del(key).catch(() => {});
    return v && v.ok ? { ok: true, detail: 'Saved and read back a test value' } : { ok: false, detail: 'Wrote a test value but could not read it back' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
const storeType = () => process.env.REDIS_URL ? 'Railway Redis (REDIS_URL)'
  : (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) ? 'Upstash' : null;

// ── Sessions ──────────────────────────────────────────────────────────────────
// The browser only holds a random session id. The Procore token lives in Redis.
const sessionKey = sid => `session:${sid}`;
const expiresAtFrom = tok => Date.now() + (Number(tok.expires_in) || 5400) * 1000;

async function exchangeToken(body) {
  const { data } = await axios.post(`${LOGIN}/oauth/token`, {
    client_id: process.env.PROCORE_CLIENT_ID,
    client_secret: process.env.PROCORE_CLIENT_SECRET,
    redirect_uri: process.env.PROCORE_REDIRECT_URI,
    ...body,
  });
  return data;
}

async function createSession(res, data) {
  const sid = crypto.randomBytes(32).toString('hex');
  await redis.set(sessionKey(sid), data, { ex: SESSION_TTL_S });
  setCookie(res, SESSION_COOKIE, sid, SESSION_TTL_S);
  return sid;
}

async function saveSession(session) {
  const { sid, ...data } = session;
  await redis.set(sessionKey(sid), data, { ex: SESSION_TTL_S });
}

async function destroySession(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await redis.del(sessionKey(sid)).catch(() => {});
  setCookie(res, SESSION_COOKIE, '', 0);
}

// Procore refresh tokens are single-use, so only one request may refresh at a time.
async function refreshSession(sid, session) {
  const lockKey = `lock:refresh:${sid}`;
  const got = await redis.set(lockKey, '1', { nx: true, ex: 30 }).catch(() => 'OK');
  if (got !== 'OK') {
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const s = await upGet(sessionKey(sid));
      if (s && s.expiresAt - Date.now() > REFRESH_BEFORE_MS) return s;
    }
    return null;
  }
  try {
    const tok = await exchangeToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    const updated = {
      ...session,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || session.refreshToken,
      expiresAt: expiresAtFrom(tok),
    };
    await redis.set(sessionKey(sid), updated, { ex: SESSION_TTL_S });
    return updated;
  } catch (e) {
    console.warn('[session] refresh failed:', e.response?.data || e.message);
    return null;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

async function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  let session = await upGet(sessionKey(sid));
  if (!session) return null;
  if (session.expiresAt - Date.now() < REFRESH_BEFORE_MS) {
    session = await refreshSession(sid, session);
    if (!session) return null;
  }
  return { ...session, sid };
}

// Sends 401/400 itself and returns null when the request can't proceed.
async function requireSession(req, res, { needCompany = true } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  const s = await getSession(req);
  if (!s) { res.status(401).json({ error: 'NOT_AUTHENTICATED' }); return null; }
  if (needCompany && !s.companyId) { res.status(400).json({ error: 'NO_COMPANY_SELECTED' }); return null; }
  return s;
}

function makeCtx(session) {
  return {
    token: session.accessToken,
    companyId: session.companyId,
    userKey: String(session.user?.id || session.sid.slice(0, 16)),
    rl: { limit: null, remaining: null, reset: null, updatedAt: null },
    lastPersist: 0,
    notes: [], // non-fatal problems worth showing in Data Health
  };
}

// ── Rate limit tracking (throttled writes to Redis) ───────────────────────────
const rlKey = userKey => `rl:${userKey}`;

function trackRateLimit(headers, ctx) {
  if (!headers) return;
  if (headers['x-rate-limit-limit'])     ctx.rl.limit     = parseInt(headers['x-rate-limit-limit'], 10);
  if (headers['x-rate-limit-remaining']) ctx.rl.remaining = parseInt(headers['x-rate-limit-remaining'], 10);
  if (headers['x-rate-limit-reset'])     ctx.rl.reset     = parseInt(headers['x-rate-limit-reset'], 10);
  ctx.rl.updatedAt = Date.now();
  if (Date.now() - ctx.lastPersist > 5000) {
    ctx.lastPersist = Date.now();
    upSet(rlKey(ctx.userKey), ctx.rl, { ex: 7200 });
  }
}

async function flushRateLimit(ctx) {
  if (ctx.rl.updatedAt) await upSet(rlKey(ctx.userKey), ctx.rl, { ex: 7200 });
}

async function getRateLimitCached(userKey) {
  return (await upGet(rlKey(userKey))) || { limit: null, remaining: null, reset: null, updatedAt: null };
}

// ── Procore HTTP ──────────────────────────────────────────────────────────────
async function procoreGet(path, ctx, params = {}, retries = 4) {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  if (ctx.companyId) headers['Procore-Company-Id'] = String(ctx.companyId);
  try {
    const res = await axios.get(`${API}${path}`, { headers, params, timeout: 30000 });
    trackRateLimit(res.headers, ctx);
    return res.data;
  } catch (err) {
    trackRateLimit(err.response?.headers, ctx);
    if (err.response?.status === 429 && retries > 0) {
      const resetAt = ctx.rl.reset ? ctx.rl.reset * 1000 : Date.now() + 15000;
      const waitMs = clamp(resetAt - Date.now() + 2000, 10000, 65000);
      console.warn(`[procore] 429 on ${path} — waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      return procoreGet(path, ctx, params, retries - 1);
    }
    throw err;
  }
}

// All pages. A 403/404 means the tool is off or no permission → treated as empty.
async function procoreGetAll(path, ctx, params = {}) {
  let page = 1, all = [];
  for (;;) {
    let results;
    try {
      results = await procoreGet(path, ctx, { ...params, per_page: 100, page });
    } catch (err) {
      if ([403, 404].includes(err.response?.status)) return all;
      throw err;
    }
    const arr = Array.isArray(results) ? results : Array.isArray(results?.data) ? results.data : [];
    all = all.concat(arr);
    if (arr.length < 100) return all;
    page++;
  }
}

const isoNoMs = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// List a project's items, optionally only those updated since a timestamp.
// Uses Procore's documented filters[updated_at]=FROM...TO range. If an endpoint
// rejects the filter, falls back to a full list for that project.
async function listProjectItems(path, ctx, params, since) {
  if (!since) return procoreGetAll(path, ctx, params);
  const from = isoNoMs(new Date(new Date(since).getTime() - 2 * 60 * 1000)); // 2-min overlap
  const to = isoNoMs(new Date(Date.now() + 60 * 1000));
  try {
    return await procoreGetAll(path, ctx, { ...params, 'filters[updated_at]': `${from}...${to}` });
  } catch (err) {
    if ([400, 422].includes(err.response?.status)) {
      console.warn(`[procore] updated_at filter rejected on ${path}; fetching full list`);
      return procoreGetAll(path, ctx, params);
    }
    throw err;
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────
// Each user's project list comes from Procore using THEIR login, so it only
// contains projects they are allowed to see (admins see every project).
// It is cached per user for 6 hours.
//
// A company-wide "seen" registry records the last time anyone saw each project
// as active. Projects nobody has seen for 30 days are dropped from saved data.
const SEEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const seenKey = companyId => `c:${companyId}:projects:seen`;

async function markProjectsSeen(companyId, list) {
  if (!list.length) return;
  const seen = (await upGet(seenKey(companyId))) || {};
  const now = Date.now();
  for (const p of list) seen[String(p.id)] = { name: p.name, at: now };
  await upSet(seenKey(companyId), seen);
}

async function getProjects(ctx, { force = false } = {}) {
  const key = `c:${ctx.companyId}:u:${ctx.userKey}:projects`;
  if (!force) {
    const cached = await upGet(key);
    if (cached?.at && Array.isArray(cached.list) && Date.now() - cached.at < PROJECTS_FRESH_MS) return cached.list;
  }
  // Procore's List Projects returns active projects this user can access.
  const raw = await procoreGetAll('/rest/v1.0/projects', ctx, { company_id: ctx.companyId });
  const list = raw.filter(p => p && p.active !== false).map(p => ({ id: p.id, name: p.name }));
  await upSet(key, { at: Date.now(), list }, { ex: 7 * 24 * 3600 });
  await markProjectsSeen(ctx.companyId, list);
  console.log(`[projects] company ${ctx.companyId}, user ${ctx.userKey}: ${list.length} accessible`);
  return list;
}

// ── Concurrency with rate-limit awareness ─────────────────────────────────────
async function throttle(ctx) {
  const { remaining, reset } = ctx.rl;
  if (remaining == null || remaining >= 25) return;
  const waitMs = remaining < 5
    ? clamp((reset ? reset * 1000 : Date.now() + 30000) - Date.now() + 3000, 15000, 65000)
    : (30 - remaining) * 300;
  console.warn(`[procore] low remaining (${remaining}) — pausing ${Math.round(waitMs / 1000)}s`);
  await sleep(waitMs);
}

async function concurrentMap(items, concurrency, fn, ctx) {
  const results = new Array(items.length);
  const skipped = [];
  let idx = 0, fatal = null;
  async function worker() {
    while (idx < items.length && !fatal) {
      const i = idx++;
      const item = items[i];
      await throttle(ctx);
      try {
        results[i] = await fn(item);
      } catch (err) {
        const status = err.response?.status;
        if (status === 401) { fatal = err; return; }
        const reason = status === 429 ? 'rate_limited' : status ? `http_${status}` : err.message;
        console.warn(`[procore] skipping ${item.name}: ${reason}`);
        skipped.push({ id: item.id, name: item.name || String(item.id), reason });
        results[i] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (fatal) throw fatal;
  return { results: results.map(r => r || []), skipped };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const ck = (companyId, resource, part) => `c:${companyId}:${resource}:${part}`;

async function getCache(companyId, resource) {
  const [data, meta] = await Promise.all([
    upGet(ck(companyId, resource, 'data')),
    upGet(ck(companyId, resource, 'meta')),
  ]);
  return { data: Array.isArray(data) ? data : null, meta: meta || null };
}

async function setCache(companyId, resource, data, meta) {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > 8 * 1024 * 1024) console.warn(`[cache] ${resource} snapshot is ${(bytes / 1048576).toFixed(1)} MB — near Upstash limits`);
  const [a, b] = await Promise.all([
    upSet(ck(companyId, resource, 'data'), data),
    upSet(ck(companyId, resource, 'meta'), meta),
  ]);
  console.log(`[cache] ${resource} company ${companyId}: ${data.length} records, ${(bytes / 1024).toFixed(0)} KB, write=${a && b ? 'ok' : 'FAILED'}`);
  return a && b;
}

function mergeRecords(existing, updates, mergeRecord) {
  const map = new Map(existing.map(r => [r.id, r]));
  for (const r of updates) {
    const old = map.get(r.id);
    map.set(r.id, old && mergeRecord ? mergeRecord(old, r) : r);
  }
  return [...map.values()];
}

async function acquireLock(key) {
  try { return (await redis.set(key, '1', { nx: true, ex: LOCK_TTL_S })) === 'OK'; }
  catch { return true; } // if Redis is down, don't block syncing
}
const releaseLock = key => redis.del(key).catch(() => {});

// ── Shared utilities ──────────────────────────────────────────────────────────
function safeStr(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (typeof val === 'object') {
    const s = val.name || val.label || val.title || val.description || val.login || null;
    return s ? String(s).trim() || null : null;
  }
  return String(val).trim() || null;
}

function safeNum(val) {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

// "Approved as Noted" → "approved_as_noted"
const normStatus = s => String(safeStr(s) || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }

function dateOnly(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Positive days since a date, else null
function daysSince(v, today) {
  const d = dateOnly(v);
  if (!d) return null;
  const n = daysBetween(d, today);
  return n > 0 ? n : null;
}

function errMsg(err) {
  const e = err.response?.data?.errors ?? err.response?.data?.message ?? err.message;
  const first = Array.isArray(e) ? e[0] : e;
  return typeof first === 'string' ? first : JSON.stringify(first);
}

// Run an optional sub-request; log and continue on errors other than auth/rate limit.
async function soft(ctx, label, fn, fallback = []) {
  try { return await fn(); }
  catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 429) throw err;
    const msg = `${label}: ${status ? `HTTP ${status}` : err.message}`;
    console.warn(`[procore] ${msg}`);
    if (ctx.notes.length < 100) ctx.notes.push(msg);
    return fallback;
  }
}

// ── Generic handler for RFIs / Submittals / Change Events / Change Orders ─────
//
// Saved data is shared per company, but:
//   • each user only receives records for projects their Procore login can see;
//   • a sync only touches the projects the syncing user can see — it never
//     removes other projects' data;
//   • every project keeps its own "last synced" time, so incremental syncs are
//     correct no matter who synced which projects before.

// When was this project last synced? Older snapshots (before per-project times)
// fall back to the snapshot's single sync time.
function syncTimeFor(meta, projectId, hasRecords) {
  if (!meta) return null;
  if (meta.projectSync) return meta.projectSync[String(projectId)] || null;
  return hasRecords ? meta.syncedAt || null : null;
}

function makeResourceHandler({ resource, concurrency = 3, fetchForProject, hydrate = r => r, mergeRecord }) {
  return async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const ctx = makeCtx(session);
    const companyId = ctx.companyId;
    let mode = req.query.force === 'true' ? 'full' : req.query.sync === 'true' ? 'sync' : 'read';

    // Everything sent to the browser goes through here: filtered to this user's projects
    const send = (records, meta, projects, cacheStatus, extra = {}) => {
      const allowed = new Map(projects.map(p => [p.id, p.name]));
      const visible = records.filter(r => allowed.has(r.project_id));
      const withRecords = new Set(visible.map(r => r.project_id));
      const times = [];
      let unsynced = 0;
      for (const id of allowed.keys()) {
        const t = syncTimeFor(meta, id, withRecords.has(id));
        if (t) times.push(t); else unsynced++;
      }
      times.sort();
      const names = [...allowed.values()];
      const userMeta = {
        syncedAt: times[0] || null,             // oldest sync among this user's projects
        lastSyncAt: meta?.syncedAt || null,     // most recent sync by anyone
        mode: meta?.mode || null,
        total: visible.length,
        withData: withRecords.size,
        withNone: Math.max(allowed.size - withRecords.size, 0),
        projectCount: allowed.size,
        unsynced,
        skipped: (meta?.skipped || []).filter(s => s && typeof s === 'object' && allowed.has(s.id)).map(s => s.name),
        notes: (meta?.notes || []).filter(n => names.some(name => String(n).startsWith(`${name} `))),
      };
      res.setHeader('X-Cache', cacheStatus);
      if (userMeta.syncedAt) res.setHeader('X-Cache-SyncedAt', userMeta.syncedAt);
      res.setHeader('X-Sync-Summary', encodeURIComponent(JSON.stringify(userMeta)));
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, String(v));
      const today = todayStr();
      res.json(visible.map(r => hydrate(r, today)));
    };

    try {
      const [cache, projects] = await Promise.all([
        getCache(companyId, resource),
        getProjects(ctx, { force: mode === 'full' }),
      ]);

      // 1. Normal page load: serve saved data (no Procore data calls) — unless none
      //    of this user's projects have ever been pulled, then pull them now.
      if (mode === 'read' && cache.data) {
        const have = new Set(cache.data.map(r => r.project_id));
        const allUnsynced = projects.length > 0 && projects.every(p => !syncTimeFor(cache.meta, p.id, have.has(p.id)));
        if (!allUnsynced) return send(cache.data, cache.meta, projects, 'HIT');
        mode = 'sync';
      }
      if (!projects.length) return send(cache.data || [], cache.meta, projects, 'HIT');

      // 2. Sync. One writer per company + tool at a time.
      const lockKey = `lock:${companyId}:${resource}`;
      if (!(await acquireLock(lockKey))) {
        if (cache.data) return send(cache.data, cache.meta, projects, 'SYNCING');
        return res.status(409).json({ error: 'SYNC_IN_PROGRESS' });
      }

      try {
        // Re-read inside the lock so we build on the newest saved copy
        const fresh = await getCache(companyId, resource);
        const data = fresh.data || [];
        const oldMeta = fresh.meta || null;
        const startedAt = new Date().toISOString();
        const haveRecords = new Set(data.map(r => r.project_id));

        const byProject = new Map();
        for (const r of data) {
          if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
          byProject.get(r.project_id).push(r);
        }

        // Per project: changes-only if it has a sync time (and this isn't a full rebuild)
        const sinceFor = new Map(projects.map(p => [
          p.id, mode === 'sync' ? syncTimeFor(oldMeta, p.id, haveRecords.has(p.id)) : null,
        ]));
        const fullCount = [...sinceFor.values()].filter(v => !v).length;
        console.log(`[${resource}] ${mode} by user ${ctx.userKey}: ${projects.length} projects (${fullCount} full, ${projects.length - fullCount} changes-only)`);

        const { results, skipped } = await concurrentMap(
          projects, concurrency,
          p => fetchForProject(ctx, p, sinceFor.get(p.id), byProject.get(p.id) || []),
          ctx
        );
        const skippedIds = new Set(skipped.map(s => s.id));

        // Build the new shared copy. Projects this user can't see are left untouched.
        const replaceIds = new Set();
        const replaceRecs = [];
        const mergeRecs = [];
        projects.forEach((p, i) => {
          if (skippedIds.has(p.id)) return;
          if (sinceFor.get(p.id)) mergeRecs.push(...results[i]);
          else { replaceIds.add(p.id); replaceRecs.push(...results[i]); }
        });
        let final = mergeRecords(data.filter(r => !replaceIds.has(r.project_id)), mergeRecs, mergeRecord).concat(replaceRecs);

        // Per-project sync times (convert older snapshots on the way)
        const projectSync = { ...(oldMeta?.projectSync || {}) };
        if (oldMeta && !oldMeta.projectSync && oldMeta.syncedAt) {
          for (const id of haveRecords) projectSync[String(id)] = oldMeta.syncedAt;
        }
        for (const p of projects) if (!skippedIds.has(p.id)) projectSync[String(p.id)] = startedAt;

        // Drop projects nobody has seen as active for 30 days
        const seen = (await upGet(seenKey(companyId))) || {};
        const now = Date.now();
        for (const p of projects) seen[String(p.id)] = { name: p.name, at: now };
        for (const r of final) if (!seen[String(r.project_id)]) seen[String(r.project_id)] = { name: r.project_name, at: now };
        const stale = new Set(Object.entries(seen).filter(([, v]) => !v?.at || v.at < now - SEEN_KEEP_MS).map(([k]) => k));
        if (stale.size) {
          final = final.filter(r => !stale.has(String(r.project_id)));
          for (const id of stale) { delete seen[id]; delete projectSync[id]; }
          console.log(`[${resource}] removed ${stale.size} project(s) not seen as active in 30 days`);
        }
        await upSet(seenKey(companyId), seen);

        const meta = {
          syncedAt: startedAt,
          mode: fullCount === projects.length ? 'full' : 'incremental',
          projectSync,
          skipped: skipped.map(s => ({ id: s.id, name: s.name })),
          notes: ctx.notes.slice(0, 50),
        };
        const ok = await setCache(companyId, resource, final, meta);
        await flushRateLimit(ctx);
        return send(final, meta, projects, meta.mode === 'full' ? 'FULL' : 'INCREMENTAL', { 'X-Cache-Write': ok ? 'ok' : 'failed' });
      } finally {
        await releaseLock(lockKey);
      }
    } catch (err) {
      console.error(`[${resource}] fatal:`, err.response?.data || err.message);
      if (err.response?.status === 401) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
      res.status(500).json({ error: errMsg(err) });
    }
  };
}

module.exports = {
  // sessions
  storeCheck, storeType,
  parseCookies, setCookie, exchangeToken, createSession, saveSession, destroySession,
  getSession, requireSession, makeCtx, expiresAtFrom,
  // procore
  procoreGet, procoreGetAll, listProjectItems, getProjects, getRateLimitCached,
  // handler + utils
  makeResourceHandler, soft, safeStr, safeNum, normStatus, daysSince, errMsg,
};
