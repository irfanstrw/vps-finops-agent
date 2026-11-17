'use strict';
// Biaya Azure asli lewat Cost Management Query API (hanya baca).
// Masuk memakai service principal (client credentials). Peran minimal: "Cost Management Reader" pada subscription.
// Data biaya Azure dapat tertunda beberapa jam. Sinkron otomatis sekali sehari, manual paling cepat tiap 10 menit.
const store = require('./store');
const pricing = require('./pricing');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const MAX_PAGES = 10;
const TIMEOUT_MS = 25000;
const API_VERSION = '2025-03-01';

const bad = (status, message) => Object.assign(new Error(message), { status });
const stored = () => (store.db.settings.azure ||= {});
const data = () => {
  const d = ((store.db.cloud ||= {}).azure ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });
  d.servers ||= [];
  return d;
};

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
  return { configured: !!c, fromEnv: !!c?.fromEnv, keyHint: c ? mask(c.client) : '', lastSync: d.lastSync, lastTry: d.lastTry, lastError: d.lastError, billingError: d.billingError || null, serversError: d.serversError || null, requests: d.requests, dayCount: Object.keys(d.days).length, serverCount: d.servers.length, currency: d.currency, minMinutes: MIN_MS / 60000 };
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

// Daftar VM di subscription. statusOnly=true menyertakan PowerState (running, deallocated, ...).
// Butuh peran Reader pada subscription (Cost Management Reader saja tidak cukup untuk membaca VM).
async function syncServers(c, d, tk) {
  const arm = process.env.AZURE_ARM_ENDPOINT || 'https://management.azure.com';
  let url = `${arm}/subscriptions/${c.subscription}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01&statusOnly=true`;
  const out = [];
  let pages = 0;
  try {
    while (url && pages < MAX_PAGES) {
      const { r, json } = await http(url, { headers: { Authorization: `Bearer ${tk}` } });
      pages++;
      if (!r.ok) {
        const e = json.error || {};
        throw new Error(`Azure menolak daftar VM (${e.code || 'HTTP ' + r.status}): ${e.message || 'tanpa pesan'}. Beri aplikasi peran Reader pada subscription.`);
      }
      for (const vm of json.value || []) out.push(normalize(vm));
      url = json.nextLink || null;
    }
  } finally {
    d.requests += pages;
  }
  d.servers = out;
}

function normalize(vm) {
  const p = vm.properties || {};
  const size = p.hardwareProfile?.vmSize || '';
  const t = pricing.byType('azure', size);
  const st = (p.instanceView?.statuses || []).map((s) => s.code || '').find((s) => s.startsWith('PowerState/')) || '';
  const power = st.split('/')[1] || '';
  const sp = p.storageProfile || {};
  const disk = (Number(sp.osDisk?.diskSizeGB) || 0) + (sp.dataDisks || []).reduce((a, x) => a + (Number(x.diskSizeGB) || 0), 0);
  return {
    provider: 'azure',
    id: vm.id || vm.name,
    name: vm.name || '',
    type: size,
    state: power === 'running' ? 'running' : /deallocat|stopp/.test(power) ? 'stopped' : power || 'unknown',
    location: vm.location || '',
    region: vm.location || '',
    vcpu: t?.vcpu ?? null,
    memGiB: t?.memGiB ?? null,
    arch: t?.arch || 'x86_64',
    diskGB: disk,
    publicIp: true,
    os: sp.osDisk?.osType || '',
    launchedAt: p.timeCreated || null,
  };
}

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial Azure belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkron terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu sebentar.`);
  d.lastTry = now;
  let tk;
  try {
    tk = await token(c);
  } catch (e) {
    d.lastError = e.message;
    store.save();
    throw e;
  }
  const [srv, bill] = await Promise.allSettled([syncServers(c, d, tk), syncBilling(c, d, now, tk)]);
  d.serversAt = now;
  d.serversError = srv.status === 'rejected' ? srv.reason.message : null;
  d.billingError = bill.status === 'rejected' ? bill.reason.message : null;
  if (srv.status === 'rejected' && bill.status === 'rejected') {
    d.lastError = `${d.serversError} ${d.billingError}`;
    store.save();
    throw new Error(d.lastError);
  }
  d.lastSync = now;
  d.lastError = null;
  store.save();
  return publicState();
}

async function syncBilling(c, d, now, tk) {
  const days = {};
  let pages = 0;
  try {
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
  } finally {
    d.requests += pages;
  }
  d.days = days;
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

// Daftar VM diperbarui paling cepat tiap menit, supaya VM yang baru dinyalakan langsung terlihat.
const LIVE_MS = 60000;
async function refreshServers(force = false) {
  const c = creds();
  if (!c) return;
  const d = data();
  if (!force && d.serversAt && Date.now() - d.serversAt < LIVE_MS) return;
  d.serversAt = Date.now();
  try {
    await syncServers(c, d, await token(c));
    d.serversError = null;
  } catch (e) {
    d.serversError = e.message;
  }
  store.save();
}

// Layanan yang termasuk biaya server di tagihan Azure.
const COMPUTE_RE = /Virtual Machines|Bandwidth|Storage|Virtual Network/i;

module.exports = { publicState, update, sync, syncIfDue, refreshServers, normalize, days: () => data().days, servers: () => data().servers, currency: () => data().currency, COMPUTE_RE };
