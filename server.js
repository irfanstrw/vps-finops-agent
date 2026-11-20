'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const pricing = require('./lib/pricing');
const automations = require('./lib/automations');
const budget = require('./lib/budget');
const llm = require('./lib/llm');
const aws = require('./lib/aws');
const azure = require('./lib/azure');
const gcp = require('./lib/gcp');
const cloud = require('./lib/cloud');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;

// ---------- admin auth ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!process.env.ADMIN_PASSWORD) {
  console.log('\nUsing default password "admin123". Set ADMIN_PASSWORD before exposing this server to a network.\n');
}
// Sessions are stateless signed cookies ("<expiry>.<hmac>") so they work across serverless instances.
const SESSION_MS = 7 * 86400000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('finops-session:' + ADMIN_PASSWORD).digest('hex');
const loginFails = new Map(); // ip -> {count, until}; per instance, best effort
const ON_VERCEL = !!process.env.VERCEL;

function signSession(exp) {
  return `${exp}.${crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex')}`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  const t = cookies(req).sid || '';
  const exp = Number(t.split('.')[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(t, signSession(exp));
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
function str(v, max, name) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} wajib diisi`);
  if (v.length > max) throw new HttpError(400, `${name} terlalu panjang (maks ${max})`);
  return v.trim();
}
// Trust forwarded headers only from Vercel's edge or a local reverse proxy/tunnel (e.g. cloudflared).
function fromLocalProxy(req) {
  if (ON_VERCEL) return true;
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function clientIp(req) {
  if (fromLocalProxy(req)) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket?.remoteAddress || 'unknown';
}
function isHttps(req) {
  return fromLocalProxy(req) && req.headers['x-forwarded-proto'] === 'https';
}

// ---------- views ----------
function chatSummary(c) {
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt };
}
function findOr404(list, id, what) {
  const x = list.find((i) => i.id === id);
  if (!x) throw new HttpError(404, `${what} tidak ditemukan`);
  return x;
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
}

// auth
route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Terlalu banyak percobaan. Tunggu satu menit.');
  const { password } = await readBody(req);
  if (!safeEqual(password || '', ADMIN_PASSWORD)) {
    const n = (f?.count || 0) + 1;
    loginFails.set(ip, { count: n, until: n >= 5 ? Date.now() + 60000 : 0 });
    throw new HttpError(401, 'Password salah');
  }
  loginFails.delete(ip);
  const t = signSession(Date.now() + SESSION_MS);
  send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}` });
}, { auth: false });

route('POST', '/api/logout', async (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
}, { auth: false });

route('GET', '/api/me', async (req, res) => send(res, 200, { authed: isAuthed(req), storage: store.backend }), { auth: false });

// Vercel Cron calls this daily. Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
route('GET', '/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) throw new HttpError(401, 'Unauthorized');
  automations.tick();
  await Promise.all([aws.syncIfDue(), azure.syncIfDue(), gcp.syncIfDue()]);
  send(res, 200, { ok: true });
}, { auth: false });

// overview: semua server terdaftar dan biayanya, dari ketiga platform
route('GET', '/api/overview', async (req, res) => {
  // Status server (running/stopped) dibaca ulang paling cepat tiap menit. Bills tetap sekali sehari.
  await Promise.all([aws.refreshServers(), azure.refreshServers(), gcp.refreshServers()]);
  // 62 hari supaya widget "dibanding bulan lalu" punya data bulan sebelumnya.
  const o = cloud.overview(62);
  send(res, 200, {
    ...o,
    status: cloud.status(),
    budget: budget.status(o.totals),
    anomalies: cloud.detectAnomalies({ fromDays: 30 }).slice(0, 10),
    savings: cloud.savings().slice(0, 10),
  });
});

// Budget bulanan: tambah, kurangi, atau tetapkan.
route('POST', '/api/budget', async (req, res) => {
  const b = await readBody(req);
  if (!['add', 'subtract', 'set'].includes(b.mode)) throw new HttpError(400, 'Mode harus add, subtract, atau set');
  budget.change(b.mode, b.amount);
  send(res, 200, budget.status(cloud.overview(30).totals));
});

// Sumber cloud (AWS, Azure, Google Cloud): semuanya baca-saja dan memakai pola yang sama.
const CLOUD = { aws, azure, gcp };
const cloudMod = (id) => {
  if (!CLOUD[id]) throw new HttpError(404, 'Sumber tidak dikenal');
  return CLOUD[id];
};
route('GET', '/api/cloud/:id', async (req, res, p) => {
  const m = cloudMod(p.id);
  await m.refreshServers();
  send(res, 200, { ...m.publicState(), summary: cloud.summarize(p.id, 30), servers: cloud.servers(p.id) });
});
// Simpan kredensial lalu langsung sinkron, jadi server muncul tanpa klik tambahan.
route('PUT', '/api/cloud/:id', async (req, res, p) => {
  const m = cloudMod(p.id);
  const b = await readBody(req);
  const st = m.update(b);
  if (b.clear === true || !st.configured) return send(res, 200, st);
  try {
    send(res, 200, await m.sync());
  } catch (e) {
    if (e.status && e.status !== 429) throw e;
    send(res, 200, { ...m.publicState(), error: e.message });
  }
});
route('POST', '/api/cloud/:id/sync', async (req, res, p) => {
  const m = cloudMod(p.id);
  try {
    send(res, 200, await m.sync());
  } catch (e) {
    // Kalau bills baru saja disinkron, tetap perbarui daftar server supaya status terbaru terlihat.
    if (e.status === 429) {
      await m.refreshServers(true);
      return send(res, 200, { ...m.publicState(), note: 'Status server diperbarui. Bills disinkron ulang paling cepat 10 menit sekali.' });
    }
    if (e.status) throw e;
    send(res, 200, { ...m.publicState(), error: e.message });
  }
});

// Planning: proyeksi biaya dari daftar sumber daya dan rekomendasi spesifikasi, tanpa server asli.
route('GET', '/api/plan/catalog', async (req, res) => {
  send(res, 200, {
    kinds: cloud.PLAN_ITEMS,
    providers: Object.fromEntries(Object.entries(pricing.PROVIDERS).map(([k, v]) => [k, { label: v.label, product: v.product, region: v.region, diskLabel: v.diskLabel, instances: v.instances }])),
    workloads: Object.fromEntries(Object.entries(cloud.WORKLOADS).map(([k, v]) => [k, { label: v.label, note: v.note }])),
    scales: cloud.SCALES,
    savedPlans: store.db.plans || [],
  });
});
route('POST', '/api/plan/recommend', async (req, res) => send(res, 200, cloud.recommend(await readBody(req))));
route('POST', '/api/plan/calc', async (req, res) => {
  const b = await readBody(req);
  if (!Array.isArray(b.items) || b.items.length > 50) throw new HttpError(400, 'Daftar sumber daya harus berupa array, paling banyak 50 baris');
  send(res, 200, cloud.plan(b.items, 12));
});
route('POST', '/api/plan/save', async (req, res) => {
  const b = await readBody(req);
  const name = str(b.name, 80, 'Nama rencana');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw new HttpError(400, 'Rencana butuh 1 sampai 50 baris sumber daya');
  const calc = cloud.plan(b.items, 12);
  store.db.plans ||= [];
  if (store.db.plans.length >= 50) throw new HttpError(400, 'Maksimum 50 rencana tersimpan. Hapus yang lama dulu.');
  const plan = { id: store.newId(), name, ts: Date.now(), items: b.items, monthly: calc.monthly };
  store.db.plans.unshift(plan);
  store.save();
  send(res, 201, plan);
});
route('DELETE', '/api/plan/:id', async (req, res, p) => {
  store.db.plans = (store.db.plans || []).filter((x) => x.id !== p.id);
  store.save();
  send(res, 200, { ok: true });
});

route('GET', '/api/pricing', async (req, res) => send(res, 200, pricing.PROVIDERS));

// chats
route('GET', '/api/chats', async (req, res) => {
  send(res, 200, [...store.db.chats].sort((a, b) => b.updatedAt - a.updatedAt).map(chatSummary));
});
route('POST', '/api/chats', async (req, res) => {
  const now = Date.now();
  const c = { id: store.newId(), title: 'Percakapan baru', createdAt: now, updatedAt: now, messages: [] };
  store.db.chats.push(c);
  store.save();
  send(res, 201, c);
});
route('DELETE', '/api/chats', async (req, res) => {
  store.db.chats = [];
  store.save();
  send(res, 200, { ok: true });
});
route('GET', '/api/chats/:id', async (req, res, p) => send(res, 200, findOr404(store.db.chats, p.id, 'Chat')));
route('DELETE', '/api/chats/:id', async (req, res, p) => {
  findOr404(store.db.chats, p.id, 'Chat');
  store.db.chats = store.db.chats.filter((c) => c.id !== p.id);
  store.save();
  send(res, 200, { ok: true });
});
route('POST', '/api/chats/:id/messages', async (req, res, p) => {
  const c = findOr404(store.db.chats, p.id, 'Chat');
  const b = await readBody(req);
  const text = str(b.text, 10000, 'text');
  const started = Date.now();
  // Cegah jawaban dobel: permintaan yang sama (klik dua kali, Enter dobel, retry jaringan) dalam 15 detik
  // mengembalikan jawaban yang sudah ada, bukan membuat pesan baru.
  const last = c.messages[c.messages.length - 1];
  const prevUser = c.messages[c.messages.length - 2];
  if (last?.role === 'agent' && prevUser?.role === 'user' && prevUser.text === text && started - prevUser.ts < 15000) {
    return send(res, 200, { chat: chatSummary(c), user: prevUser, agent: last, duplicate: true });
  }
  const history = c.messages.slice(-8);
  c.messages.push({ id: store.newId(), role: 'user', text, ts: started });
  const { reply, engine } = await llm.respond(text, history);
  const msg = { id: store.newId(), role: 'agent', reply, engine, ts: Date.now() };
  c.messages.push(msg);
  if (c.title === 'Percakapan baru' || c.title === 'New chat') c.title = reply.title;
  c.updatedAt = Date.now();
  store.save();
  send(res, 200, { chat: chatSummary(c), user: c.messages[c.messages.length - 2], agent: msg });
});

// automations
route('GET', '/api/automations', async (req, res) => send(res, 200, store.db.automations));
route('PATCH', '/api/automations/:id', async (req, res, p) => {
  const a = findOr404(store.db.automations, p.id, 'Automation');
  const b = await readBody(req);
  if (typeof b.enabled === 'boolean') a.enabled = b.enabled;
  if (b.intervalHours !== undefined) {
    const n = Number(b.intervalHours);
    if (!Number.isFinite(n) || n < 1 || n > 720) throw new HttpError(400, 'Interval harus 1–720 jam');
    a.intervalHours = n;
  }
  store.save();
  send(res, 200, a);
});
route('POST', '/api/automations/:id/run', async (req, res, p) => {
  const a = findOr404(store.db.automations, p.id, 'Automation');
  send(res, 200, automations.run(a, 'manual'));
});

// artifacts
route('GET', '/api/artifacts', async (req, res) => {
  send(res, 200, store.db.artifacts.map(({ reply, ...rest }) => rest));
});
route('GET', '/api/artifacts/:id', async (req, res, p) => send(res, 200, findOr404(store.db.artifacts, p.id, 'Artifact')));
route('POST', '/api/artifacts', async (req, res) => {
  const { chatId, messageId } = await readBody(req);
  const c = findOr404(store.db.chats, chatId, 'Chat');
  const m = c.messages.find((x) => x.id === messageId && x.role === 'agent');
  if (!m) throw new HttpError(404, 'Pesan tidak ditemukan');
  const a = { id: store.newId(), ts: Date.now(), title: `${m.reply.title}, ${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`, source: `chat:${c.id}`, reply: m.reply };
  store.db.artifacts.unshift(a);
  store.save();
  send(res, 201, { id: a.id });
});
route('POST', '/api/artifacts/delete', async (req, res) => {
  const b = await readBody(req);
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 500 || b.ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'Daftar id artifact tidak valid');
  const drop = new Set(b.ids);
  const before = store.db.artifacts.length;
  store.db.artifacts = store.db.artifacts.filter((a) => !drop.has(a.id));
  store.save();
  send(res, 200, { ok: true, deleted: before - store.db.artifacts.length });
});
route('DELETE', '/api/artifacts/:id', async (req, res, p) => {
  findOr404(store.db.artifacts, p.id, 'Artifact');
  store.db.artifacts = store.db.artifacts.filter((a) => a.id !== p.id);
  store.save();
  send(res, 200, { ok: true });
});

// context files
route('GET', '/api/context-files', async (req, res) => send(res, 200, store.db.contextFiles));
route('POST', '/api/context-files', async (req, res) => {
  const b = await readBody(req);
  const f = { id: store.newId(), name: str(b.name, 200, 'Nama'), content: str(b.content, 100000, 'Isi'), ts: Date.now() };
  store.db.contextFiles.push(f);
  store.save();
  send(res, 201, f);
});
route('DELETE', '/api/context-files/:id', async (req, res, p) => {
  findOr404(store.db.contextFiles, p.id, 'Context file');
  store.db.contextFiles = store.db.contextFiles.filter((f) => f.id !== p.id);
  store.save();
  send(res, 200, { ok: true });
});

// AI model slots
route('GET', '/api/ai', async (req, res) => send(res, 200, llm.publicSettings()));
route('PUT', '/api/ai/:slot', async (req, res, p) => send(res, 200, llm.update(p.slot, await readBody(req))));
route('POST', '/api/ai/:slot/test', async (req, res, p) => {
  if (!['primary', 'backup'].includes(p.slot)) throw new HttpError(400, 'Slot tidak dikenal');
  try {
    send(res, 200, await llm.test(p.slot));
  } catch (e) {
    send(res, 200, { ok: false, error: e.message });
  }
});

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:",
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}

// ---------- request handler (shared by local server and Vercel) ----------
async function prepare() {
  await store.load();
  migrate();
  automations.migrate();
}

// Data dari versi lama (VPS lewat agent dan VPS sample) tidak dipakai lagi.
function migrate() {
  const db = store.db;
  if (db.vps || db.usage || db.events || db.egressByMonth || db.tasks) {
    delete db.vps;
    delete db.usage;
    delete db.events;
    delete db.egressByMonth;
    delete db.tasks;
    store.save();
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.auth && !isAuthed(req)) throw new HttpError(401, 'Belum login');
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        await prepare();
        // Run due automations lazily, so they also work where no background timer exists (serverless).
        if (r.auth) automations.tick();
        try {
          return await r.handler(req, res, params);
        } finally {
          await store.persist().catch((e) => console.error('Failed to save data:', e));
        }
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : e.message });
  }
}

module.exports = { handler };

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, HOST, () => {
    console.log(`FinOps Agent running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Storage: ${store.backend}`);
  });
  // Background tick for automations when running as a normal server.
  setInterval(async () => {
    try {
      await prepare();
      automations.tick();
      await Promise.all([aws.syncIfDue(), azure.syncIfDue(), gcp.syncIfDue()]);
      await store.persist();
    } catch (e) {
      console.error('Automation tick failed:', e);
    }
  }, 60000).unref();

  const shutdown = () => store.persist().catch(() => {}).finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
