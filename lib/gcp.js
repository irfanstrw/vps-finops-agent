'use strict';
// Biaya Google Cloud asli lewat ekspor penagihan standar di BigQuery (hanya baca).
// Google tidak menyediakan API biaya langsung: biaya harus diekspor dulu ke tabel BigQuery
// (gcp_billing_export_v1_<BILLING_ACCOUNT_ID>), lalu dibaca dengan service account baca-saja.
// Peran minimal: BigQuery Data Viewer pada dataset ekspor dan BigQuery Job User pada project.
// Token memakai alur JWT bearer (RFC 7523), tanpa library tambahan.
const crypto = require('node:crypto');
const store = require('./store');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const TIMEOUT_MS = 30000;

const bad = (status, message) => Object.assign(new Error(message), { status });
const stored = () => (store.db.settings.gcp ||= {});
const data = () => ((store.db.cloud ||= {}).gcp ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });
const b64 = (x) => Buffer.from(x).toString('base64url');

function parseKey(raw) {
  let j;
  try {
    j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw bad(400, 'File kunci bukan JSON yang valid');
  }
  if (!j || j.type !== 'service_account' || !j.client_email || !j.private_key || !j.project_id) throw bad(400, 'Ini bukan kunci service account Google (butuh type, client_email, private_key, project_id)');
  try {
    crypto.createPrivateKey(j.private_key);
  } catch {
    throw bad(400, 'private_key pada file kunci tidak valid');
  }
  return { client_email: j.client_email, private_key: j.private_key, project_id: j.project_id };
}

function creds() {
  const env = process.env.FINOPS_GCP_SERVICE_ACCOUNT_JSON;
  const s = stored();
  if (env && process.env.FINOPS_GCP_BILLING_TABLE) {
    try {
      return { key: parseKey(env), table: process.env.FINOPS_GCP_BILLING_TABLE, fromEnv: true };
    } catch {
      return null;
    }
  }
  return s.key && s.table ? { key: s.key, table: s.table, fromEnv: false } : null;
}

function publicState() {
  const c = creds();
  const d = data();
  return { configured: !!c, fromEnv: !!c?.fromEnv, keyHint: c ? c.key.client_email : '', table: c?.table || '', lastSync: d.lastSync, lastTry: d.lastTry, lastError: d.lastError, requests: d.requests, dayCount: Object.keys(d.days).length, currency: d.currency, minMinutes: MIN_MS / 60000 };
}

// Nama tabel: project.dataset.tabel (huruf, angka, strip, underscore, titik). Dipakai langsung di SQL, jadi dibatasi ketat.
const TABLE = /^[a-z][a-z0-9-]{4,60}\.[A-Za-z0-9_]{1,100}\.[A-Za-z0-9_]{1,100}$/;

function update(b) {
  if (b.clear === true) {
    delete store.db.settings.gcp;
    store.db.cloud && delete store.db.cloud.gcp;
    store.save();
    return publicState();
  }
  const key = parseKey(String(b.serviceAccountJson || ''));
  const table = String(b.table || '').trim();
  if (!TABLE.test(table)) throw bad(400, 'Nama tabel harus berbentuk project.dataset.tabel, misalnya mi-proyek.billing.gcp_billing_export_v1_XXXXXX');
  Object.assign(stored(), { key, table });
  data().lastError = null;
  store.save();
  return publicState();
}

async function http(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return { r, json: await r.json().catch(() => ({})) };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timeout ${TIMEOUT_MS / 1000} detik` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function signJwt(key, now, aud) {
  const iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly', aud, iat, exp: iat + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

async function token(c, now) {
  const endpoint = process.env.GCP_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(c.key, now, endpoint) });
  const { r, json } = await http(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok || !json.access_token) throw new Error(`Google menolak login (${json.error || 'HTTP ' + r.status}): ${json.error_description || 'tanpa pesan'}. Cek file kunci service account.`);
  return json.access_token;
}

// Biaya bersih = cost ditambah semua kredit (kredit bernilai negatif), per hari dan per layanan.
function sql(table) {
  return `SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day, service.description AS service, ` +
    `ANY_VALUE(currency) AS currency, SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost ` +
    `FROM \`${table}\` WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${WINDOW_DAYS - 1} DAY) GROUP BY day, service ORDER BY day`;
}

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial Google Cloud belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkronisasi terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu dulu.`);
  d.lastTry = now;
  const days = {};
  let calls = 0;
  try {
    const tk = await token(c, now);
    calls++;
    const bq = process.env.GCP_BQ_ENDPOINT || 'https://bigquery.googleapis.com';
    const { r, json } = await http(`${bq}/bigquery/v2/projects/${encodeURIComponent(c.key.project_id)}/queries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql(c.table), useLegacySql: false, timeoutMs: 20000, maximumBytesBilled: String(2 * 1024 * 1024 * 1024) }),
    });
    calls++;
    if (!r.ok) {
      const e = json.error || {};
      throw new Error(`BigQuery menolak permintaan (${e.status || 'HTTP ' + r.status}): ${e.message || 'tanpa pesan'}. Cek nama tabel dan peran BigQuery Data Viewer serta BigQuery Job User.`);
    }
    if (json.jobComplete === false) throw new Error('Query BigQuery belum selesai dalam batas waktu. Coba sinkron lagi sebentar lagi.');
    for (const row of json.rows || []) {
      const f = row.f || [];
      const day = f[0]?.v;
      const svc = f[1]?.v || 'Lainnya';
      const amt = Number(f[3]?.v);
      if (f[2]?.v) d.currency = f[2].v;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(amt) || Math.abs(amt) < 1e-9) continue;
      days[day] ||= {};
      days[day][svc] = (days[day][svc] || 0) + amt;
    }
  } catch (e) {
    d.requests += calls;
    d.lastError = e.message;
    store.save();
    throw e;
  }
  d.days = days;
  d.requests += calls;
  d.lastSync = now;
  d.lastError = null;
  store.save();
  return publicState();
}

async function syncIfDue() {
  const d = data();
  if (!creds()) return;
  if (d.lastSync && Date.now() - d.lastSync < DAY_MS) return;
  if (d.lastTry && Date.now() - d.lastTry < MIN_MS) return;
  try {
    await sync();
  } catch (e) {
    console.error('Sinkronisasi Google Cloud gagal:', e.message);
  }
}

module.exports = { publicState, update, sync, syncIfDue, days: () => data().days, currency: () => data().currency, sql };
