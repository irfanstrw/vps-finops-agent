'use strict';
// Tagihan AWS asli lewat Cost Explorer (hanya baca, kredensial IAM terpisah).
// Satu permintaan API Cost Explorer berbayar $0.01 per halaman hasil, jadi sinkronisasi dibatasi:
// otomatis sekali sehari, manual paling cepat tiap 10 menit.
const crypto = require('node:crypto');
const store = require('./store');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const MAX_PAGES = 5;
const TIMEOUT_MS = 20000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// AWS Signature Version 4.
function signV4({ method, host, path = '/', query = {}, headers = {}, body = '', region, service, accessKey, secretKey, sessionToken, amzDate }) {
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-date': amzDate };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;
  const h = {};
  for (const k of Object.keys(all)) h[k.toLowerCase()] = String(all[k]).trim().replace(/\s+/g, ' ');
  const names = Object.keys(h).sort();
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, path, canonicalQuery, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { headers: h, authorization, signature };
}

// ---------- kredensial dan data ----------
function stored() {
  return (store.db.settings.aws ||= {});
}
function data() {
  store.db.cloud ||= {};
  return (store.db.cloud.aws ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });
}
function creds() {
  const envId = process.env.FINOPS_AWS_ACCESS_KEY_ID;
  const envSecret = process.env.FINOPS_AWS_SECRET_ACCESS_KEY;
  if (envId && envSecret) return { accessKey: envId, secretKey: envSecret, fromEnv: true };
  const s = stored();
  return s.accessKeyId && s.secretAccessKey ? { accessKey: s.accessKeyId, secretKey: s.secretAccessKey, fromEnv: false } : null;
}
const mask = (k) => (k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`);

function publicState() {
  const c = creds();
  const d = data();
  return {
    configured: !!c,
    fromEnv: !!c?.fromEnv,
    keyHint: c ? mask(c.accessKey) : '',
    lastSync: d.lastSync,
    lastTry: d.lastTry,
    lastError: d.lastError,
    requests: d.requests,
    dayCount: Object.keys(d.days).length,
    currency: d.currency,
    minMinutes: MIN_MS / 60000,
  };
}

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

function update(b) {
  const s = stored();
  if (b.clear === true) {
    delete store.db.settings.aws;
    store.db.cloud && delete store.db.cloud.aws;
    store.save();
    return publicState();
  }
  const id = String(b.accessKeyId || '').trim();
  const secret = String(b.secretAccessKey || '').trim();
  if (!/^[A-Z0-9]{16,128}$/.test(id)) throw bad(400, 'Access key ID tidak valid (huruf besar dan angka, 16 karakter atau lebih)');
  if (secret.length < 20 || secret.length > 100 || /\s/.test(secret)) throw bad(400, 'Secret access key tidak valid');
  s.accessKeyId = id;
  s.secretAccessKey = secret;
  data().lastError = null;
  store.save();
  return publicState();
}

// ---------- Cost Explorer ----------
async function ce(c, payload) {
  const endpoint = process.env.AWS_CE_ENDPOINT || 'https://ce.us-east-1.amazonaws.com';
  const u = new URL(endpoint);
  const body = JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const sig = signV4({
    method: 'POST',
    host: u.host,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
    body,
    region: 'us-east-1',
    service: 'ce',
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    amzDate,
  });
  const headers = { ...sig.headers, authorization: sig.authorization };
  delete headers.host;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: ctrl.signal });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = String(json.__type || '').split('#').pop();
      const hint = /AccessDenied|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch/.test(code) ? ' Cek access key, secret, dan izin ce:GetCostAndUsage.' : '';
      throw new Error(`AWS menolak permintaan (${code || 'HTTP ' + r.status}): ${json.message || json.Message || 'tanpa pesan'}.${hint}`);
    }
    return json;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timeout ${TIMEOUT_MS / 1000} detik` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial AWS belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkronisasi terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu dulu supaya biaya API tetap kecil.`);
  d.lastTry = now;
  const start = new Date(now - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(now + DAY_MS).toISOString().slice(0, 10); // batas akhir eksklusif
  const days = {};
  let token;
  let pages = 0;
  try {
    do {
      const res = await ce(c, {
        TimePeriod: { Start: start, End: end },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        ...(token ? { NextPageToken: token } : {}),
      });
      pages++;
      for (const row of res.ResultsByTime || []) {
        const date = row.TimePeriod?.Start;
        if (!date) continue;
        days[date] ||= {};
        for (const g of row.Groups || []) {
          const m = g.Metrics?.UnblendedCost;
          const amt = Number(m?.Amount);
          if (m?.Unit) d.currency = m.Unit;
          if (Number.isFinite(amt) && Math.abs(amt) > 1e-9) days[date][g.Keys?.[0] || 'Lainnya'] = amt;
        }
      }
      token = res.NextPageToken;
    } while (token && pages < MAX_PAGES);
  } catch (e) {
    d.requests += pages;
    d.lastError = e.message;
    store.save();
    throw e;
  }
  d.days = days;
  d.requests += pages;
  d.lastSync = now;
  d.lastError = null;
  store.save();
  return publicState();
}

// Sinkronisasi otomatis: sekali sehari saja.
async function syncIfDue() {
  const d = data();
  if (!creds()) return;
  if (d.lastSync && Date.now() - d.lastSync < DAY_MS) return;
  if (d.lastTry && Date.now() - d.lastTry < MIN_MS) return;
  try {
    await sync();
  } catch (e) {
    console.error('Sinkronisasi AWS gagal:', e.message);
  }
}

// ---------- laporan ----------
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

function report(days = 30, now = Date.now()) {
  const d = data();
  const keys = Object.keys(d.days).sort();
  if (!keys.length) return null;
  const from = new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const window = keys.filter((k) => k >= from);
  const bySvc = {};
  for (const k of window) for (const [s, a] of Object.entries(d.days[k])) bySvc[s] = (bySvc[s] || 0) + a;
  const month = new Date(now).toISOString().slice(0, 7);
  return {
    currency: d.currency,
    lastDate: keys[keys.length - 1],
    lastSync: d.lastSync,
    days: window.map((k) => ({ date: k, total: sum(d.days[k]) })),
    services: Object.entries(bySvc).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    total: sum(bySvc),
    mtd: keys.filter((k) => k.startsWith(month)).reduce((a, k) => a + sum(d.days[k]), 0),
    raw: d.days,
  };
}

module.exports = { signV4, publicState, update, sync, syncIfDue, report, days: () => data().days, currency: () => data().currency };
