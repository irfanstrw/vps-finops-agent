'use strict';
// Google Cloud, read-only, dengan satu service account:
//   1. Daftar VM Compute Engine (wajib). Peran: Compute Viewer.
//   2. Tagihan dari ekspor penagihan BigQuery (opsional, kalau tabel diisi). Google tidak punya API biaya langsung,
//      jadi biaya harus diekspor dulu. Peran: BigQuery Data Viewer pada dataset dan BigQuery Job User pada project.
// Token memakai alur JWT bearer (RFC 7523), tanpa library tambahan.
const crypto = require('node:crypto');
const store = require('./store');
const pricing = require('./pricing');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 62; // dua bulan, untuk perbandingan dengan bulan lalu
const TIMEOUT_MS = 30000;

const bad = (status, message) => Object.assign(new Error(message), { status });
const stored = () => (store.db.settings.gcp ||= {});
const data = () => {
  const d = ((store.db.cloud ||= {}).gcp ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });
  d.servers ||= [];
  return d;
};
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
  if (env) {
    try {
      return { key: parseKey(env), table: process.env.FINOPS_GCP_BILLING_TABLE || '', fromEnv: true };
    } catch {
      return null;
    }
  }
  return s.key ? { key: s.key, table: s.table || '', fromEnv: false } : null;
}

function publicState() {
  const c = creds();
  const d = data();
  return { configured: !!c, fromEnv: !!c?.fromEnv, keyHint: c ? c.key.client_email : '', table: c?.table || '', lastSync: d.lastSync, lastTry: d.lastTry, lastError: d.lastError, billingError: d.billingError || null, serversError: d.serversError || null, requests: d.requests, dayCount: Object.keys(d.days).length, serverCount: d.servers.length, currency: d.currency, minMinutes: MIN_MS / 60000 };
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
  const table = String(b.table || '').trim();
  if (table && !TABLE.test(table)) throw bad(400, 'Nama tabel harus berbentuk project.dataset.tabel, misalnya proyek-saya.billing.gcp_billing_export_v1_XXXXXX');
  const raw = String(b.serviceAccountJson || '').trim();
  // Boleh hanya mengganti tabel kalau kunci sudah tersimpan.
  const key = raw ? parseKey(raw) : stored().key;
  if (!key) throw bad(400, 'Tempel isi file kunci service account (JSON)');
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
  const claims = b64(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/compute.readonly https://www.googleapis.com/auth/bigquery.readonly', aud, iat, exp: iat + 3600 }));
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

// Daftar VM Compute Engine di project kunci (aggregatedList mencakup semua zona).
// Peran minimal: Compute Viewer pada project.
async function syncServers(c, d, tk) {
  const base = process.env.GCP_COMPUTE_ENDPOINT || 'https://compute.googleapis.com';
  const out = [];
  let pageToken = '';
  let calls = 0;
  try {
    do {
      const u = `${base}/compute/v1/projects/${encodeURIComponent(c.key.project_id)}/aggregated/instances?maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const { r, json } = await http(u, { headers: { Authorization: `Bearer ${tk}` } });
      calls++;
      if (!r.ok) {
        const e = json.error || {};
        throw new Error(`Compute Engine menolak daftar VM (${e.status || 'HTTP ' + r.status}): ${e.message || 'tanpa pesan'}. Beri service account peran Compute Viewer.`);
      }
      for (const scope of Object.values(json.items || {})) for (const vm of scope.instances || []) out.push(normalize(vm));
      pageToken = json.nextPageToken || '';
    } while (pageToken && calls < 20);
  } finally {
    d.requests += calls;
  }
  d.servers = out;
}

const last = (u) => String(u || '').split('/').pop();

function normalize(vm) {
  const type = last(vm.machineType);
  const t = pricing.byType('gcp', type);
  const disk = (vm.disks || []).reduce((a, x) => a + (Number(x.diskSizeGb) || 0), 0);
  const zone = last(vm.zone);
  const st = String(vm.status || '');
  return {
    provider: 'gcp',
    id: String(vm.id || vm.name),
    name: vm.name || '',
    type,
    state: st === 'RUNNING' ? 'running' : /TERMINATED|STOPP|SUSPEND/.test(st) ? 'stopped' : st.toLowerCase() || 'unknown',
    location: zone,
    region: zone.replace(/-[a-z]$/, ''),
    vcpu: t?.vcpu ?? null,
    memGiB: t?.memGiB ?? null,
    arch: t?.arch || 'x86_64',
    diskGB: disk,
    publicIp: (vm.networkInterfaces || []).some((n) => (n.accessConfigs || []).some((a) => a.natIP || a.type === 'ONE_TO_ONE_NAT')),
    os: '',
    launchedAt: vm.creationTimestamp || null,
  };
}

async function syncBilling(c, d, tk) {
  const days = {};
  let calls = 0;
  try {
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
  } finally {
    d.requests += calls;
  }
  d.days = days;
}

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial Google Cloud belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkron terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu sebentar.`);
  d.lastTry = now;
  let tk;
  try {
    tk = await token(c, now);
    d.requests++;
  } catch (e) {
    d.lastError = e.message;
    store.save();
    throw e;
  }
  const jobs = [syncServers(c, d, tk), c.table ? syncBilling(c, d, tk) : Promise.resolve('skip')];
  const [srv, bill] = await Promise.allSettled(jobs);
  d.serversAt = now;
  d.serversError = srv.status === 'rejected' ? srv.reason.message : null;
  d.billingError = bill.status === 'rejected' ? bill.reason.message : null;
  if (!c.table) d.days = {};
  if (srv.status === 'rejected' && (bill.status === 'rejected' || !c.table)) {
    d.lastError = [d.serversError, d.billingError].filter(Boolean).join(' ');
    store.save();
    throw new Error(d.lastError);
  }
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
    console.error('Sinkron Google Cloud gagal:', e.message);
  }
}

// Daftar VM diperbarui paling cepat tiap menit, supaya VM yang baru dinyalakan langsung terlihat.
const LIVE_MS = 60000;
async function refreshServers(force = false) {
  const c = creds();
  if (!c) return;
  const d = data();
  if (!force && d.serversAt && Date.now() - d.serversAt < LIVE_MS) return;
  d.serversAt = Date.now();
  try {
    await syncServers(c, d, await token(c, Date.now()));
    d.serversError = null;
  } catch (e) {
    d.serversError = e.message;
  }
  store.save();
}

// Layanan yang termasuk biaya server di bills Google Cloud.
const COMPUTE_RE = /Compute Engine|Networking/i;

module.exports = { publicState, update, sync, syncIfDue, refreshServers, normalize, sql, days: () => data().days, servers: () => data().servers, currency: () => data().currency, COMPUTE_RE };
