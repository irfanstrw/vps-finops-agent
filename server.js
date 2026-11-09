'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const costs = require('./lib/costs');
const pricing = require('./lib/pricing');
const agent = require('./lib/agent');
const automations = require('./lib/automations');
const demo = require('./lib/demo');
const llm = require('./lib/llm');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_DIR = path.join(__dirname, 'agent');
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
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
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
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`;
}

// ---------- views ----------
function vpsView(v) {
  const t = costs.effectiveType(v);
  const mtd = costs.monthToDate().byVps[v.id] || 0;
  return {
    id: v.id,
    name: v.name,
    demo: !!v.demo,
    createdAt: v.createdAt,
    lastSeen: v.lastSeen,
    status: v.demo ? 'sample' : !v.lastSeen ? 'pending' : costs.isOnline(v) ? 'online' : 'offline',
    active: !!v.active,
    instanceType: t?.type || null,
    hourly: t?.hourly || null,
    projectedMonthly: v.demo ? demo.projectedMonthly(v.instanceType, v.last?.diskTotalGB || 0) : null,
    last: v.last,
    mtd,
  };
}
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
  send(res, 200, { ok: true });
}, { auth: false });

// overview
route('GET', '/api/overview', async (req, res) => {
  const mtd = costs.monthToDate();
  send(res, 200, {
    region: pricing.REGION,
    balance: costs.balance(),
    forecast: costs.forecast(),
    mtd,
    budget: agent.budgetFromContext(),
    daily: costs.dailySeries(costs.daysBack(30)),
    vps: store.db.vps.map(vpsView),
    anomalies: costs.detectAnomalies({ fromDays: 30 }).slice(0, 10),
  });
});

route('GET', '/api/pricing', async (req, res) => {
  send(res, 200, {
    region: pricing.REGION,
    instances: pricing.INSTANCE_TYPES,
    ebsGp3: pricing.EBS_GP3_USD_PER_GB_MONTH,
    ipv4Hourly: pricing.PUBLIC_IPV4_USD_PER_HOUR,
    egressPerGB: pricing.EGRESS_USD_PER_GB,
    egressFreeGB: pricing.EGRESS_FREE_GB_PER_MONTH,
  });
});

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
route('GET', '/api/chats/:id', async (req, res, p) => send(res, 200, findOr404(store.db.chats, p.id, 'Chat')));
route('DELETE', '/api/chats/:id', async (req, res, p) => {
  findOr404(store.db.chats, p.id, 'Chat');
  store.db.chats = store.db.chats.filter((c) => c.id !== p.id);
  store.save();
  send(res, 200, { ok: true });
});
route('POST', '/api/chats/:id/messages', async (req, res, p) => {
  const c = findOr404(store.db.chats, p.id, 'Chat');
  const text = str((await readBody(req)).text, 10000, 'text');
  const started = Date.now();
  c.messages.push({ id: store.newId(), role: 'user', text, ts: started });
  const { reply, engine } = await llm.respond(text);
  const msg = { id: store.newId(), role: 'agent', reply, engine, ts: Date.now() };
  c.messages.push(msg);
  if (c.title === 'Percakapan baru' || c.title === 'New chat') c.title = reply.title;
  c.updatedAt = Date.now();
  automations.addTask({ name: reply.title, kind: 'chat', trigger: 'chat', status: 'ok', summary: text.slice(0, 140), chatId: c.id, durationMs: Date.now() - started });
  store.save();
  send(res, 200, { chat: chatSummary(c), user: c.messages[c.messages.length - 2], agent: msg });
});

// tasks
route('GET', '/api/tasks', async (req, res) => send(res, 200, store.db.tasks || []));

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
  if (b.monthlyBudgetUsd !== undefined && a.type === 'budget') {
    const n = Number(b.monthlyBudgetUsd);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Budget tidak boleh negatif');
    a.params.monthlyBudgetUsd = n;
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
  const a = { id: store.newId(), ts: Date.now(), title: `${m.reply.title} — ${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`, source: `chat:${c.id}`, reply: m.reply };
  store.db.artifacts.unshift(a);
  store.save();
  send(res, 201, { id: a.id });
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

// settings
route('POST', '/api/settings/topup', async (req, res) => {
  const n = Number((await readBody(req)).amount);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new HttpError(400, 'Jumlah harus antara 1 dan 100000');
  store.db.settings.topups ||= [];
  store.db.settings.topups.push({ ts: Date.now(), amount: n });
  store.save();
  send(res, 200, costs.balance());
});

// VPS integration
route('GET', '/api/vps', async (req, res) => send(res, 200, store.db.vps.map(vpsView)));
route('POST', '/api/vps', async (req, res) => {
  const name = str((await readBody(req)).name, 60, 'Nama');
  if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, 'Nama hanya boleh berisi huruf, angka, titik, strip, dan underscore');
  if (store.db.vps.some((v) => v.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'VPS dengan nama itu sudah ada');
  const token = 'fop_' + crypto.randomBytes(24).toString('base64url');
  const v = { id: store.newId(), name, createdAt: Date.now(), tokenHash: sha256(token), instanceType: null, lastSeen: null, last: null };
  store.db.vps.push(v);
  store.save();
  // The token is returned once. Only its hash is stored.
  send(res, 201, { vps: vpsView(v), token, serverUrl: baseUrl(req) });
});
route('POST', '/api/vps/:id/rotate', async (req, res, p) => {
  const v = findOr404(store.db.vps, p.id, 'VPS');
  if (v.demo) throw new HttpError(400, 'VPS sample tidak memakai agent');
  const token = 'fop_' + crypto.randomBytes(24).toString('base64url');
  v.tokenHash = sha256(token);
  store.save();
  send(res, 200, { vps: vpsView(v), token, serverUrl: baseUrl(req) });
});
route('DELETE', '/api/vps/:id', async (req, res, p) => {
  findOr404(store.db.vps, p.id, 'VPS');
  store.db.vps = store.db.vps.filter((v) => v.id !== p.id);
  delete store.db.usage[p.id];
  store.save();
  send(res, 200, { ok: true });
});
// VPS sample AWS: pick an EC2 type; only a projected cost, no history.
route('POST', '/api/samples', async (req, res) => {
  const b = await readBody(req);
  const name = str(b.name, 60, 'Nama');
  if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, 'Nama hanya boleh berisi huruf, angka, titik, strip, dan underscore');
  send(res, 201, vpsView(demo.create({ name, instanceType: String(b.instanceType || ''), diskGB: b.diskGB })));
});
route('PATCH', '/api/vps/:id', async (req, res, p) => {
  const v = findOr404(store.db.vps, p.id, 'VPS');
  const b = await readBody(req);
  if (typeof b.active === 'boolean') {
    if (!v.demo) throw new HttpError(400, 'Hanya VPS sample yang bisa diaktifkan proyeksinya');
    v.active = b.active;
  }
  store.save();
  send(res, 200, vpsView(v));
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

// agent endpoints (token auth, no session)
route('POST', '/agent/v1/heartbeat', async (req, res) => {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  const v = m && store.db.vps.find((x) => x.tokenHash && x.tokenHash === sha256(m[1]));
  if (!v) throw new HttpError(401, 'Invalid token');
  if (v.lastSeen && Date.now() - v.lastSeen < 10000) throw new HttpError(429, 'Too frequent');
  const body = await readBody(req);
  send(res, 200, { ok: true, ...costs.ingest(v, body) });
}, { auth: false });

// Scripts are served with LF endings so they run on Linux even if edited on Windows.
function agentScript(name) {
  return fs.readFileSync(path.join(AGENT_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}
const SH = { 'Content-Type': 'text/x-shellscript; charset=utf-8' };
route('GET', '/agent/install.sh', async (req, res) => {
  // Only substitute a URL that is safe to embed in a shell string.
  const url = baseUrl(req);
  if (!/^https?:\/\/[\w.:\-\[\]]+(\/[\w.\-\/]*)?$/.test(url)) throw new HttpError(400, 'Invalid Host header');
  send(res, 200, agentScript('install.sh').replaceAll('__DEFAULT_SERVER__', url), SH);
}, { auth: false });
route('GET', '/agent/finops-agent.sh', async (req, res) => send(res, 200, agentScript('finops-agent.sh'), SH), { auth: false });
route('GET', '/agent/uninstall.sh', async (req, res) => send(res, 200, agentScript('uninstall.sh'), SH), { auth: false });

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
  demo.migrate();
  automations.migrate();
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/') || pathname.startsWith('/agent/')) {
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
    console.log(`Pricing: AWS on-demand ${pricing.REGION.code} · storage: ${store.backend}`);
  });
  // Background tick for automations when running as a normal server.
  setInterval(async () => {
    try {
      await prepare();
      automations.tick();
      await store.persist();
    } catch (e) {
      console.error('Automation tick failed:', e);
    }
  }, 60000).unref();

  const shutdown = () => store.persist().catch(() => {}).finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
