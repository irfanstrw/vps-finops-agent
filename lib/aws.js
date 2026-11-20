'use strict';
// AWS, read-only. Dua sumber data dengan satu kredensial IAM:
//   1. Daftar server EC2 per region (DescribeInstances + DescribeVolumes), gratis.
//   2. Tagihan harian per layanan dari Cost Explorer, $0.01 per halaman hasil.
// Sinkron otomatis sekali sehari, manual paling cepat tiap 10 menit.
const crypto = require('node:crypto');
const store = require('./store');
const pricing = require('./pricing');

const MIN_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const WINDOW_DAYS = 62; // dua bulan, untuk perbandingan dengan bulan lalu
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
  return { headers: h, authorization, signature, canonicalQuery };
}

// ---------- kredensial dan data ----------
function stored() {
  return (store.db.settings.aws ||= {});
}
function data() {
  store.db.cloud ||= {};
  const d = (store.db.cloud.aws ||= { days: {}, lastSync: null, lastTry: null, lastError: null, requests: 0, currency: 'USD' });
  d.servers ||= [];
  return d;
}
// Semua server dan harga memakai satu region: US East (N. Virginia).
const REGION = 'us-east-1';
const regions = () => [REGION];
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
    billingError: d.billingError || null,
    serversError: d.serversError || null,
    requests: d.requests,
    dayCount: Object.keys(d.days).length,
    serverCount: d.servers.length,
    regions: regions(),
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
  delete s.regions;
  if (!/^[A-Z0-9]{16,128}$/.test(id)) throw bad(400, 'Access key ID tidak valid (huruf besar dan angka, 16 karakter atau lebih)');
  if (secret.length < 20 || secret.length > 100 || /\s/.test(secret)) throw bad(400, 'Secret access key tidak valid');
  s.accessKeyId = id;
  s.secretAccessKey = secret;
  data().lastError = null;
  store.save();
  return publicState();
}

async function timed(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timeout ${TIMEOUT_MS / 1000} detik` : e.message);
  } finally {
    clearTimeout(timer);
  }
}
const amzNow = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

// ---------- Cost Explorer ----------
async function ce(c, payload) {
  const endpoint = process.env.AWS_CE_ENDPOINT || 'https://ce.us-east-1.amazonaws.com';
  const u = new URL(endpoint);
  const body = JSON.stringify(payload);
  const sig = signV4({
    method: 'POST',
    host: u.host,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
    body,
    region: 'us-east-1',
    service: 'ce',
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    amzDate: amzNow(),
  });
  const headers = { ...sig.headers, authorization: sig.authorization };
  delete headers.host;
  const r = await timed(endpoint, { method: 'POST', headers, body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(json.__type || '').split('#').pop();
    const msg = json.message || json.Message || '';
    if (/not enabled for cost explorer|DataUnavailable/i.test(code + ' ' + msg)) {
      throw new Error('Cost Explorer belum aktif. Buka Billing and Cost Management, lalu Cost Explorer, sekali saja. AWS butuh sampai 24 jam sebelum bills bisa dibaca.');
    }
    const hint = /AccessDenied|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch/.test(code) ? ' Cek access key, secret, dan izin ce:GetCostAndUsage.' : '';
    throw new Error(`Cost Explorer menolak permintaan (${code || 'HTTP ' + r.status}): ${msg || 'tanpa pesan'}.${hint}`);
  }
  return json;
}

// Usage type AWS diawali kode region (tanpa awalan berarti us-east-1).
const REGION_CODES = {
  USE1: 'us-east-1', USE2: 'us-east-2', USW1: 'us-west-1', USW2: 'us-west-2', CAN1: 'ca-central-1',
  EUC1: 'eu-central-1', EU: 'eu-west-1', EUW2: 'eu-west-2', EUW3: 'eu-west-3', EUN1: 'eu-north-1',
  APS1: 'ap-southeast-1', APS2: 'ap-southeast-2', APS3: 'ap-south-1', APN1: 'ap-northeast-1', APN2: 'ap-northeast-2', APN3: 'ap-northeast-3',
  SAE1: 'sa-east-1', ME1: 'me-south-1', AFS1: 'af-south-1',
};
function describeUsage(u) {
  const m = /^([A-Z]{2,4}\d?)-(.+)$/.exec(u);
  const known = m && REGION_CODES[m[1]];
  const region = known ? REGION_CODES[m[1]] : m ? m[1] : 'us-east-1';
  const rest = known || (m && /^[A-Z]{2,4}\d$/.test(m[1])) ? m[2] : u;
  let kind = rest;
  if (/^BoxUsage/.test(rest)) kind = `Server running ${rest.split(':')[1] || ''}`.trim();
  else if (/^EBS:VolumeUsage/.test(rest)) kind = `Disk EBS ${rest.split('.')[1] || 'standard'}`;
  else if (/^EBS:SnapshotUsage/.test(rest)) kind = 'Snapshot EBS';
  else if (/^EBS:VolumeP-IOPS|^EBS:VolumeP-Throughput/.test(rest)) kind = 'IOPS atau throughput EBS';
  else if (/PublicIPv4:IdleAddress|ElasticIP:IdleAddress/.test(rest)) kind = 'IPv4 publik tidak terpakai';
  else if (/PublicIPv4:InUseAddress|ElasticIP/.test(rest)) kind = 'IPv4 publik';
  else if (/NatGateway-Hours/.test(rest)) kind = 'NAT Gateway (per jam)';
  else if (/NatGateway-Bytes/.test(rest)) kind = 'NAT Gateway (data)';
  else if (/DataTransfer-Out|AWS-Out-Bytes/.test(rest)) kind = 'Data transfer keluar';
  else if (/DataTransfer-Regional|DataTransfer-In/.test(rest)) kind = 'Data transfer antar zona';
  else if (/CPUCredits/.test(rest)) kind = 'CPU credits instance T (unlimited)';
  else if (/LoadBalancerUsage|LCUUsage/.test(rest)) kind = 'Load balancer';
  const cat = /^BoxUsage|CPUCredits/.test(rest) ? 'compute' : /^EBS:/.test(rest) ? (/Snapshot/.test(rest) ? 'snapshot' : 'disk') : /IPv4|ElasticIP/.test(rest) ? 'ip' : /DataTransfer|Bytes/.test(rest) ? 'transfer' : 'other';
  const type = /^BoxUsage:(.+)$/.exec(rest)?.[1] || null;
  return { region, kind, cat, type };
}

async function syncBilling(c, d, now) {
  const start = new Date(now - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(now + DAY_MS).toISOString().slice(0, 10); // batas akhir eksklusif
  // Dikelompokkan per layanan dan RECORD_TYPE supaya pemakaian (Usage) terpisah dari kredit (Credit, Refund).
  // days = biaya sebelum kredit, credits = kredit yang dipakai (angka positif).
  const days = {};
  const credits = {};
  let token;
  let pages = 0;
  try {
    do {
      const res = await ce(c, {
        TimePeriod: { Start: start, End: end },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'RECORD_TYPE' }],
        ...(token ? { NextPageToken: token } : {}),
      });
      pages++;
      for (const row of res.ResultsByTime || []) {
        const date = row.TimePeriod?.Start;
        if (!date) continue;
        for (const g of row.Groups || []) {
          const m = g.Metrics?.UnblendedCost;
          const amt = Number(m?.Amount);
          if (m?.Unit) d.currency = m.Unit;
          if (!Number.isFinite(amt) || Math.abs(amt) < 1e-9) continue;
          const svc = g.Keys?.[0] || 'Lainnya';
          const type = g.Keys?.[1] || 'Usage';
          if (/Credit|Refund/i.test(type)) {
            credits[date] ||= {};
            credits[date][svc] = (credits[date][svc] || 0) - amt;
          } else {
            days[date] ||= {};
            days[date][svc] = (days[date][svc] || 0) + amt;
          }
        }
      }
      token = res.NextPageToken;
    } while (token && pages < MAX_PAGES);
  } finally {
    d.requests += pages;
  }
  d.days = days;
  d.credits = credits;
  // Rincian bills bulan ini per usage type (contoh: USE1-BoxUsage:t2.micro, APS1-EBS:VolumeUsage.gp2),
  // supaya kelihatan biaya datang dari region dan komponen mana. Satu permintaan tambahan sehari.
  try {
    const m0 = new Date(now).toISOString().slice(0, 8) + '01';
    const res = await ce(c, {
      TimePeriod: { Start: m0, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      Filter: { And: [
        { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other'] } },
        { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } },
      ] },
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
    });
    d.requests += 1;
    const agg = {};
    for (const row of res.ResultsByTime || []) {
      for (const g of row.Groups || []) {
        const amt = Number(g.Metrics?.UnblendedCost?.Amount);
        if (Number.isFinite(amt) && amt > 0.00005) agg[g.Keys?.[0] || 'Lainnya'] = (agg[g.Keys?.[0] || 'Lainnya'] || 0) + amt;
      }
    }
    d.usageMtd = Object.entries(agg).map(([usageType, amount]) => ({ usageType, ...describeUsage(usageType), amount })).sort((a, b) => b.amount - a.amount);
    d.usageMonth = m0.slice(0, 7);
  } catch {
    d.usageMtd = null;
  }
}

// ---------- EC2 (Query API, respons XML) ----------
// Parser XML kecil: cukup untuk respons EC2 yang strukturnya tetap. Tidak mendukung CDATA atau atribut.
function xmlTree(xml) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.text += m[4];
    } else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const node = { name: m[2], children: [], text: '' };
      top.children.push(node);
      if (!m[3]) stack.push(node);
    }
  }
  return root;
}
const kid = (n, name) => n?.children.find((c) => c.name === name) || null;
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const txt = (n, name) => {
  const k = name ? kid(n, name) : n;
  return k ? k.text.trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : '';
};
const find = (n, name) => {
  if (!n) return null;
  if (n.name === name) return n;
  for (const c of n.children) {
    const f = find(c, name);
    if (f) return f;
  }
  return null;
};

async function ec2(c, region, params) {
  const endpoint = process.env.AWS_EC2_ENDPOINT || `https://ec2.${region}.amazonaws.com`;
  const u = new URL(endpoint);
  const query = { Version: '2016-11-15', ...params };
  const sig = signV4({ method: 'GET', host: u.host, query, region, service: 'ec2', accessKey: c.accessKey, secretKey: c.secretKey, amzDate: amzNow() });
  const headers = { ...sig.headers, authorization: sig.authorization };
  delete headers.host;
  const r = await timed(`${endpoint.replace(/\/+$/, '')}/?${sig.canonicalQuery}`, { method: 'GET', headers });
  const tree = xmlTree(await r.text());
  if (!r.ok) {
    const err = find(tree, 'Error');
    const code = txt(err, 'Code');
    const hint = /UnauthorizedOperation|AuthFailure|InvalidClientTokenId|SignatureDoesNotMatch/.test(code) ? ' Cek izin ec2:DescribeInstances dan ec2:DescribeVolumes.' : '';
    throw new Error(`EC2 ${region} menolak permintaan (${code || 'HTTP ' + r.status}): ${txt(err, 'Message') || 'tanpa pesan'}.${hint}`);
  }
  return tree;
}

function parseInstances(tree, region) {
  const out = [];
  for (const res of kids(find(tree, 'reservationSet'), 'item')) {
    for (const it of kids(kid(res, 'instancesSet'), 'item')) {
      const tags = kids(kid(it, 'tagSet'), 'item');
      const nameTag = tags.find((t) => txt(t, 'key') === 'Name');
      out.push({
        id: txt(it, 'instanceId'),
        name: nameTag ? txt(nameTag, 'value') : '',
        type: txt(it, 'instanceType'),
        state: txt(kid(it, 'instanceState'), 'name'),
        zone: txt(kid(it, 'placement'), 'availabilityZone'),
        region,
        arch: txt(it, 'architecture') === 'arm64' ? 'arm64' : 'x86_64',
        os: txt(it, 'platformDetails') || '',
        launchedAt: txt(it, 'launchTime') || null,
        publicIp: !!txt(it, 'ipAddress'),
      });
    }
  }
  return { list: out, next: txt(find(tree, 'nextToken')) || null };
}

function parseVolumes(tree) {
  const byInstance = {};
  for (const v of kids(find(tree, 'volumeSet'), 'item')) {
    const size = Number(txt(v, 'size')) || 0;
    for (const a of kids(kid(v, 'attachmentSet'), 'item')) {
      const id = txt(a, 'instanceId');
      if (id) byInstance[id] = (byInstance[id] || 0) + size;
    }
  }
  return { byInstance, next: txt(find(tree, 'nextToken')) || null };
}

async function syncServers(c, d) {
  const all = [];
  let calls = 0;
  try {
    for (const region of regions()) {
      const inst = [];
      let token = null;
      do {
        const p = parseInstances(await ec2(c, region, { Action: 'DescribeInstances', MaxResults: '1000', ...(token ? { NextToken: token } : {}) }), region);
        calls++;
        inst.push(...p.list);
        token = p.next;
      } while (token && calls < 50);
      const disks = {};
      token = null;
      if (inst.length) {
        do {
          const p = parseVolumes(await ec2(c, region, { Action: 'DescribeVolumes', MaxResults: '500', ...(token ? { NextToken: token } : {}) }));
          calls++;
          Object.assign(disks, p.byInstance);
          token = p.next;
        } while (token && calls < 100);
      }
      for (const i of inst) if (i.state !== 'terminated') all.push({ ...i, diskGB: disks[i.id] || 0 });
    }
  } finally {
    d.requests += calls;
  }
  d.servers = all.map((s) => normalize(s));
}

// Bentuk server yang sama untuk semua platform.
function normalize(s) {
  const t = pricing.byType('aws', s.type);
  return {
    provider: 'aws',
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    state: s.state === 'running' ? 'running' : s.state === 'stopped' || s.state === 'stopping' ? 'stopped' : s.state || 'unknown',
    location: s.zone || s.region,
    region: s.region,
    vcpu: t?.vcpu ?? null,
    memGiB: t?.memGiB ?? null,
    arch: t?.arch || s.arch,
    diskGB: s.diskGB,
    publicIp: s.publicIp !== false,
    os: s.os,
    launchedAt: s.launchedAt,
  };
}

async function sync() {
  const c = creds();
  if (!c) throw bad(400, 'Kredensial AWS belum diisi');
  const d = data();
  const now = Date.now();
  if (d.lastTry && now - d.lastTry < MIN_MS) throw bad(429, `Sinkron terakhir kurang dari ${MIN_MS / 60000} menit lalu. Tunggu sebentar.`);
  d.lastTry = now;
  const [srv, bill] = await Promise.allSettled([syncServers(c, d), syncBilling(c, d, now)]);
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

// Daftar server diperbarui paling cepat tiap menit (gratis), supaya server yang baru dinyalakan langsung terlihat.
const LIVE_MS = 60000;
async function refreshServers(force = false) {
  const c = creds();
  if (!c) return;
  const d = data();
  if (!force && d.serversAt && Date.now() - d.serversAt < LIVE_MS) return;
  d.serversAt = Date.now();
  try {
    await syncServers(c, d);
    d.serversError = null;
  } catch (e) {
    d.serversError = e.message;
  }
  store.save();
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
    console.error('Sinkron AWS gagal:', e.message);
  }
}

// Layanan yang termasuk biaya server di tagihan AWS.
const COMPUTE_RE = /Elastic Compute Cloud|^EC2|Amazon EC2/i;

module.exports = {
  signV4, xmlTree, parseInstances, parseVolumes, normalize, publicState, update, sync, syncIfDue, refreshServers,
  days: () => data().days, credits: () => data().credits || {}, describeUsage,
  usageMtd: () => (data().usageMonth === new Date().toISOString().slice(0, 7) ? data().usageMtd || null : null), servers: () => data().servers, currency: () => data().currency, COMPUTE_RE,
};
