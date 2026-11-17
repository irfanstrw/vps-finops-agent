'use strict';
// Lapisan data terpusat. Setiap sumber biaya (VPS lewat agent, AWS, Azure, GCP) diubah ke bentuk yang sama,
// sehingga dashboard, chat, dan ekspor tidak peduli asalnya:
//   days[YYYY-MM-DD][namaLayanan] = jumlah biaya (angka)
// Sumber cloud memakai API baca-saja milik vendor masing-masing. Hanya sumber `vps` yang berupa estimasi.
const store = require('./store');
const costs = require('./costs');
const pricing = require('./pricing');

const DAY_MS = 86400000;
const iso = (ts) => new Date(ts).toISOString().slice(0, 10);

const SOURCES = {
  vps: { label: 'VPS (estimasi)', kind: 'estimate', note: 'Pemakaian agent dikalikan harga AWS us-east-1 on-demand' },
  aws: { label: 'AWS', kind: 'billed', note: 'Cost Explorer, tertunda sampai 24 jam' },
  azure: { label: 'Azure', kind: 'billed', note: 'Cost Management Query API, tertunda beberapa jam' },
  gcp: { label: 'Google Cloud', kind: 'billed', note: 'Ekspor penagihan BigQuery, tertunda beberapa jam' },
};

function providerModule(id) {
  if (id === 'aws') return require('./aws');
  if (id === 'azure') return require('./azure');
  if (id === 'gcp') return require('./gcp');
  return null;
}

// Data harian per layanan dari agent VPS.
function vpsDays() {
  const out = {};
  for (const v of store.db.vps) {
    if (v.demo) continue;
    for (const [date, b] of Object.entries(store.db.usage[v.id] || {})) {
      for (const [key, name] of Object.entries(costs.SERVICES)) {
        const c = b.cost[key];
        if (c > 0) {
          out[date] ||= {};
          out[date][name] = (out[date][name] || 0) + c;
        }
      }
    }
  }
  return out;
}

function daysFor(id) {
  if (id === 'vps') return vpsDays();
  const mod = providerModule(id);
  return mod ? mod.days() : {};
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// Ringkasan satu sumber untuk `n` hari terakhir.
function summarize(id, n = 30, now = Date.now()) {
  const days = daysFor(id);
  const keys = Object.keys(days).sort();
  if (!keys.length) return null;
  const from = iso(now - (n - 1) * DAY_MS);
  const inWin = keys.filter((k) => k >= from);
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = iso(now - i * DAY_MS);
    series.push({ date: d, total: days[d] ? sum(days[d]) : 0, services: days[d] || {} });
  }
  const bySvc = {};
  for (const k of inWin) for (const [s, a] of Object.entries(days[k])) bySvc[s] = (bySvc[s] || 0) + a;
  const month = iso(now).slice(0, 7);
  const mtd = keys.filter((k) => k.startsWith(month)).reduce((a, k) => a + sum(days[k]), 0);
  const total = sum(bySvc);
  const elapsed = Math.max(1, new Date(now).getUTCDate());
  const dim = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0)).getUTCDate();
  const last7 = series.slice(-7).filter((d) => d.total > 0);
  const avg7 = last7.length ? last7.reduce((a, d) => a + d.total, 0) / last7.length : 0;
  return {
    id,
    label: SOURCES[id].label,
    kind: SOURCES[id].kind,
    lastDate: keys[keys.length - 1],
    series,
    total,
    mtd,
    // Perkiraan akhir bulan dari rata-rata 7 hari terakhir (kalau ada), jika tidak dari rata-rata bulan berjalan.
    forecastMonth: mtd + avg7 * Math.max(0, dim - elapsed),
    avg7,
    services: Object.entries(bySvc).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  };
}

// Status koneksi tiap sumber, tanpa membocorkan rahasia.
function status() {
  const out = {};
  for (const id of Object.keys(SOURCES)) {
    if (id === 'vps') {
      const real = store.db.vps.filter((v) => !v.demo);
      out.vps = { id, ...SOURCES.vps, configured: real.length > 0, count: real.length };
    } else {
      out[id] = { id, ...SOURCES[id], ...providerModule(id).publicState() };
    }
  }
  return out;
}

// Gabungan semua sumber yang punya data, dipisah menurut jenisnya (tagihan asli vs estimasi).
function overview(n = 30, now = Date.now()) {
  const per = {};
  for (const id of Object.keys(SOURCES)) {
    const s = summarize(id, n, now);
    if (s) per[id] = s;
  }
  const billed = Object.values(per).filter((s) => s.kind === 'billed');
  const series = [];
  for (let i = 0; i < n; i++) {
    const date = iso(now - (n - 1 - i) * DAY_MS);
    const row = { date, total: 0 };
    for (const s of Object.values(per)) {
      const v = s.series[i].total;
      row[s.id] = v;
      row.total += v;
    }
    series.push(row);
  }
  return {
    sources: per,
    series,
    billedTotal: billed.reduce((a, s) => a + s.total, 0),
    billedMtd: billed.reduce((a, s) => a + s.mtd, 0),
    billedForecast: billed.reduce((a, s) => a + s.forecastMonth, 0),
  };
}

// ---------- perencanaan: proyeksi dari daftar sumber daya, tanpa server asli ----------
// Daftar kategori yang bisa direncanakan. Harga EC2/EBS/IPv4/egress dari pricing.js, sisanya harga
// daftar AWS us-east-1 (statis, perlu dicek ulang di halaman harga AWS sebelum dipakai untuk keputusan).
const PLAN_ITEMS = {
  ec2: { label: 'Server EC2', unit: 'instance', calc: (i) => (pricing.byType(i.type)?.hourly || 0) * pricing.HOURS_PER_MONTH + pricing.PUBLIC_IPV4_USD_PER_HOUR * pricing.HOURS_PER_MONTH },
  ebs: { label: 'Disk EBS gp3', unit: 'GB', calc: (i) => pricing.EBS_GP3_USD_PER_GB_MONTH * i.qty },
  s3: { label: 'Penyimpanan S3 Standard', unit: 'GB', calc: (i) => 0.023 * i.qty },
  egress: { label: 'Data transfer keluar', unit: 'GB per bulan', calc: (i) => Math.max(0, i.qty - pricing.EGRESS_FREE_GB_PER_MONTH) * pricing.EGRESS_USD_PER_GB },
  nat: { label: 'NAT Gateway', unit: 'gateway', calc: (i) => 0.045 * pricing.HOURS_PER_MONTH * i.qty + 0.045 * (i.gbProcessed || 0) },
  alb: { label: 'Application Load Balancer', unit: 'load balancer', calc: (i) => 0.0225 * pricing.HOURS_PER_MONTH * i.qty },
};

function plan(items, months = 12) {
  const rows = [];
  let monthly = 0;
  for (const raw of items || []) {
    const def = PLAN_ITEMS[raw.kind];
    if (!def) throw Object.assign(new Error(`Jenis sumber daya tidak dikenal: ${raw.kind}`), { status: 400 });
    const qty = Number(raw.qty ?? 1);
    if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw Object.assign(new Error('Jumlah harus antara 0 dan 100000'), { status: 400 });
    if (raw.kind === 'ec2' && !pricing.byType(raw.type)) throw Object.assign(new Error('Tipe EC2 tidak dikenal'), { status: 400 });
    const item = { ...raw, qty };
    // EC2 dikalikan jumlah instance. Jenis lain menghitung qty di dalam calc.
    const m = raw.kind === 'ec2' ? def.calc(item) * qty : def.calc(item);
    monthly += m;
    rows.push({ kind: raw.kind, label: def.label, detail: raw.kind === 'ec2' ? `${raw.type} x ${qty}` : `${qty} ${def.unit}`, monthly: m });
  }
  const growth = [];
  for (let i = 1; i <= months; i++) growth.push({ month: i, cumulative: monthly * i });
  return { rows, monthly, yearly: monthly * 12, growth };
}

module.exports = { SOURCES, daysFor, summarize, status, overview, plan, PLAN_ITEMS, iso, DAY_MS };
