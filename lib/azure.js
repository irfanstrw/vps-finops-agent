'use strict';
// Biaya Azure asli lewat Cost Management Query API (hanya baca).
// Masuk memakai service principal (client credentials). Peran minimal: "Cost Management Reader" pada subscription.
// Data biaya Azure dapat tertunda beberapa jam. Sinkron otomatis sekali sehari, manual paling cepat tiap 10 menit.
const store = require('./store');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const MAX_PAGES = 10;
const TIMEOUT_MS = 25000;
const API_VERSION = '2025-03-01';

const bad = (status, message) => Object.assign(new Error(message), { status });
const stored = () => (store.db.settings.azure ||= {});
const data = () => ((store.db.cloud ||= {}).azure ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });

function creds() {
  const e = process.env;
  if (e.FINOPS_AZURE_TENANT_ID && e.FINOPS_AZURE_CLIENT_ID && e.FINOPS_AZURE_CLIENT_SECRET && e.FINOPS_AZURE_SUBSCRIPTION_ID) {
    return { tenant: e.FINOPS_AZURE_TENANT_ID, client: e.FINOPS_AZURE_CLIENT_ID, secret: e.FINOPS_AZURE_CLIENT_SECRET, subscription: e.FINOPS_AZURE_SUBSCRIPTION_ID, fromEnv: true };
  }
  const s = stored();
  return s.tenantId && s.clientId && s.clientSecret && s.subscriptionId ? { tenant: s.tenantId, client: s.clientId, secret: s.clientSecret, subscription: s.subscriptionId, fromEnv: false } : null;
}
const mask = (k) => (k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`);

function publicState() {
  const c = creds();
  const d = data();
  return { configured: !!c, fromEnv: !!c?.fromEnv, keyHint: c ? mask(c.client) : '', lastSync: d.lastSync, lastTry: d.lastTry, lastError: d.lastError, requests: d.requests, dayCount: Object.keys(d.days).length, currency: d.currency, minMinutes: MIN_MS / 60000 };
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function update(b) {
  if (b.clear === true) {
    delete store.db.settings.azure;
    store.db.cloud && delete store.db.cloud.azure;
    store.save();
    return publicState();
  }
  const tenantId = String(b.tenantId || '').trim();
  const clientId = String(b.clientId || '').trim();
  const subscriptionId = String(b.subscriptionId || '').trim();
  const clientSecret = String(b.clientSecret || '').trim();
  if (!GUID.test(tenantId)) throw bad(400, 'Tenant ID harus berupa GUID');
  if (!GUID.test(clientId)) throw bad(400, 'Client ID harus berupa GUID');
  if (!GUID.test(subscriptionId)) throw bad(400, 'Subscription ID harus berupa GUID');
  if (clientSecret.length < 8 || clientSecret.length > 200 || /\s/.test(clientSecret)) throw bad(400, 'Client secret tidak valid');
  Object.assign(stored(), { tenantId, clientId, subscriptionId, clientSecret });
  data().lastError = null;
  store.save();
  return publicState();
}

async function http(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await r.json().catch(() => ({}));
    return { r, json };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timeout ${TIMEOUT_MS / 1000} detik` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function token(c) {
  const base = process.env.AZURE_LOGIN_ENDPOINT || 'https://login.microsoftonline.com';
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client, client_secret: c.secret, scope: 'https://management.azure.com/.default' });
  const { r, json } = await http(`${base}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok || !json.access_token) {
    throw new Error(`Azure menolak login (${json.error || 'HTTP ' + r.status}): ${String(json.error_description || '').split('\r\n')[0] || 'tanpa pesan'}. Cek tenant ID, client ID, dan client secret.`);
  }
  return json.access_token;
}

// UsageDate dari Azure berbentuk angka 20260115.
const toDate = (n) => {
  const s = String(n);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial Azure belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkronisasi terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu dulu.`);
  d.lastTry = now;
  const days = {};
  let pages = 0;
  try {
    const tk = await token(c);
    const arm = process.env.AZURE_ARM_ENDPOINT || 'https://management.azure.com';
    let url = `${arm}/subscriptions/${c.subscription}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
    const body = JSON.stringify({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: new Date(now - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00Z', to: new Date(now).toISOString().slice(0, 10) + 'T23:59:59Z' },
      dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'ServiceName' }] },
    });
    while (url && pages < MAX_PAGES) {
      const { r, json } = await http(url, { method: 'POST', headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }, body });
      pages++;
      if (r.status === 429) throw new Error('Azure membatasi permintaan (429). Coba lagi beberapa menit lagi.');
      if (!r.ok) {
        const e = json.error || {};
        throw new Error(`Azure menolak permintaan (${e.code || 'HTTP ' + r.status}): ${e.message || 'tanpa pesan'}. Cek peran Cost Management Reader pada subscription.`);
      }
      const props = json.properties || {};
      const col = (props.columns || []).map((x) => x.name);
      const iCost = col.indexOf('PreTaxCost') >= 0 ? col.indexOf('PreTaxCost') : col.indexOf('Cost');
      const iDate = col.indexOf('UsageDate');
      const iSvc = col.indexOf('ServiceName');
      const iCur = col.indexOf('Currency');
      if (iCost < 0 || iDate < 0) throw new Error('Format respons Azure tidak dikenali (kolom biaya atau tanggal tidak ada)');
      for (const row of props.rows || []) {
        const date = toDate(row[iDate]);
        const amt = Number(row[iCost]);
        if (!date || !Number.isFinite(amt) || Math.abs(amt) < 1e-9) continue;
        if (iCur >= 0 && row[iCur]) d.currency = row[iCur];
        const name = (iSvc >= 0 && row[iSvc]) || 'Lainnya';
        days[date] ||= {};
        days[date][name] = (days[date][name] || 0) + amt;
      }
      url = props.nextLink || null;
    }
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

async function syncIfDue() {
  const d = data();
  if (!creds()) return;
  if (d.lastSync && Date.now() - d.lastSync < DAY_MS) return;
  if (d.lastTry && Date.now() - d.lastTry < MIN_MS) return;
  try {
    await sync();
  } catch (e) {
    console.error('Sinkronisasi Azure gagal:', e.message);
  }
}

module.exports = { publicState, update, sync, syncIfDue, days: () => data().days, currency: () => data().currency };
