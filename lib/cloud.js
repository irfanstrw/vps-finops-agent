'use strict';
// Lapisan data terpusat untuk server di AWS, Azure, dan Google Cloud.
// Dua jenis data per platform, semuanya dari API read-only milik vendor:
//   servers: daftar server terdaftar (EC2, Azure VM, Compute Engine) dalam bentuk yang sama
//   days:    tagihan harian per layanan, days[YYYY-MM-DD][layanan] = jumlah
// Biaya per server adalah estimasi dari daftar harga on-demand (pricing.js). Tagihan adalah angka asli vendor,
// difilter ke layanan yang berkaitan dengan server (compute, disk, jaringan).
const pricing = require('./pricing');

const DAY_MS = 86400000;
const iso = (ts) => new Date(ts).toISOString().slice(0, 10);
const IDS = ['aws', 'azure', 'gcp'];
const LABEL = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud' };
const mod = (id) => require('./' + id);

function monthInfo(now = Date.now()) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { start, dim, day: d.getUTCDate(), month: iso(now).slice(0, 7), left: dim - d.getUTCDate() };
}

// ---------- server ----------
// Estimasi per server: server running = compute + disk + IPv4; server stopped = disk saja (compute tidak ditagih).
function priced(s) {
  const p = pricing.PROVIDERS[s.provider];
  const t = pricing.byType(s.provider, s.type);
  const disk = (s.diskGB || 0) * p.diskPerGBMonth;
  const running = s.state === 'running';
  const compute = running && t ? t.hourly * pricing.HOURS_PER_MONTH : 0;
  const ip = running && s.publicIp ? p.ipv4Hourly * pricing.HOURS_PER_MONTH : 0;
  return { ...s, hourly: running && t ? t.hourly : 0, monthly: compute + disk + ip, parts: { compute, disk, ip }, known: !!t };
}

function servers(only) {
  const out = [];
  for (const id of only ? [only] : IDS) for (const s of mod(id).servers()) out.push(priced(s));
  return out;
}

// ---------- tagihan ----------
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// Tagihan harian yang berkaitan dengan server saja.
function computeDays(id) {
  const re = mod(id).COMPUTE_RE;
  const out = {};
  for (const [date, svc] of Object.entries(mod(id).days())) {
    for (const [name, amt] of Object.entries(svc)) {
      if (!re.test(name)) continue;
      out[date] ||= {};
      out[date][name] = amt;
    }
  }
  return out;
}

// Ringkasan satu platform.
function summarize(id, n = 30, now = Date.now()) {
  const list = servers(id);
  const days = computeDays(id);
  const keys = Object.keys(days).sort();
  const m = monthInfo(now);
  const estDaily = (list.reduce((a, s) => a + s.monthly, 0) / pricing.HOURS_PER_MONTH) * 24;
  const billed = keys.length > 0;
  // Tanpa tagihan, nilai harian = estimasi dari server yang sudah dibuat pada hari itu (ditandai est).
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = iso(now - i * DAY_MS);
    if (billed) {
      series.push({ date: d, total: days[d] ? sum(days[d]) : 0 });
    } else {
      const endOfDay = Date.parse(d) + DAY_MS;
      const v = list.filter((s) => !s.launchedAt || Date.parse(s.launchedAt) < endOfDay).reduce((a, s) => a + s.monthly / pricing.HOURS_PER_MONTH * 24, 0);
      series.push({ date: d, total: v, est: true });
    }
  }
  const mtdBilled = keys.filter((k) => k.startsWith(m.month)).reduce((a, k) => a + sum(days[k]), 0);
  const last7 = series.slice(-8, -1).filter((x) => x.total > 0); // hari ini belum lengkap
  const avg7 = last7.length ? last7.reduce((a, x) => a + x.total, 0) / last7.length : 0;
  // Tanpa tagihan: biaya bulan berjalan diperkirakan dari daftar server (server yang dibuat bulan ini dihitung sejak dibuat).
  let mtdEst = 0;
  for (const s of list) {
    const since = Math.max(m.start, s.launchedAt ? Date.parse(s.launchedAt) || m.start : m.start);
    const hrs = Math.max(0, (now - since) / 3600000);
    mtdEst += (s.monthly / pricing.HOURS_PER_MONTH) * hrs;
  }
  // Sisa hari bulan ini dihitung dari kondisi server SEKARANG (running atau stopped), bukan rata-rata bills lama.
  // Kalau server baru saja di-stop, biaya ke depan langsung turun ke biaya disk saja.
  const perDay = estDaily;
  // Bills bisa menyisakan angka negatif sangat kecil dari pembulatan AWS; anggap nol.
  const mtd = Math.max(0, billed ? mtdBilled : mtdEst);
  const bySvc = {};
  const from = iso(now - (n - 1) * DAY_MS);
  for (const k of keys) if (k >= from) for (const [s, a] of Object.entries(days[k])) bySvc[s] = (bySvc[s] || 0) + a;
  // Kredit (misalnya AWS Promotional Credits) yang menutup biaya server bulan ini. Hanya tersedia dari bills.
  const cr = mod(id).credits ? mod(id).credits() : {};
  const re = mod(id).COMPUTE_RE;
  let creditMtd = 0;
  for (const [date, svc] of Object.entries(cr)) {
    if (!date.startsWith(m.month)) continue;
    for (const [name, amt] of Object.entries(svc)) if (re.test(name)) creditMtd += amt;
  }
  creditMtd = Math.min(creditMtd, mtd);
  // Rincian estimasi bulan penuh per komponen, dari daftar server.
  const parts = list.reduce((a, s) => ({ compute: a.compute + s.parts.compute, disk: a.disk + s.parts.disk, ip: a.ip + s.parts.ip }), { compute: 0, disk: 0, ip: 0 });
  return {
    id,
    label: LABEL[id],
    configured: mod(id).publicState().configured,
    servers: list.length,
    running: list.filter((s) => s.state === 'running').length,
    stopped: list.filter((s) => s.state === 'stopped').length,
    estMonthly: list.reduce((a, s) => a + s.monthly, 0),
    estDaily,
    billed,
    lastDate: keys[keys.length - 1] || null,
    series,
    mtd,
    creditMtd,
    paidMtd: mtd - creditMtd,
    parts,
    perDay,
    remaining: perDay * m.left,
    forecastMonth: mtd + perDay * m.left,
    basis: billed ? 'Bills' : 'Estimasi',
    avg7,
    usage: mod(id).usageMtd ? mod(id).usageMtd() : null,
    services: Object.entries(bySvc).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  };
}

// Gabungan semua platform: dipakai dashboard, chat, dan automation.
function overview(n = 30, now = Date.now()) {
  const per = {};
  for (const id of IDS) per[id] = summarize(id, n, now);
  const m = monthInfo(now);
  // Biaya bulan ini per server, supaya jumlah per server sama dengan total bill platformnya:
  //   sisa bulan ini = kondisi server sekarang x hari tersisa
  //   sudah terpakai = bills platform dibagi ke server menurut porsi estimasinya; bagian bills yang tidak bisa
  //   dikaitkan ke server mana pun (server sudah dihapus, region lain) ditampilkan sebagai baris tersendiri.
  const HPD = 24 / pricing.HOURS_PER_MONTH;
  const list = servers().map((s) => ({ ...s, daily: s.monthly * HPD }));
  const unassigned = []; // hanya untuk debug di server, tidak dikirim ke dashboard
  const restOf = (s) => ({ compute: s.parts.compute * HPD * m.left, disk: s.parts.disk * HPD * m.left, ip: s.parts.ip * HPD * m.left });
  const finish = (s, used) => {
    const rest = restOf(s);
    s.breakdown = ['compute', 'disk', 'ip', 'snapshot', 'transfer', 'other']
      .map((k) => ({ key: k, used: used[k] || 0, rest: rest[k] || 0 }))
      .filter((b) => b.used > 0.00005 || b.rest > 0.00005);
    s.used = s.breakdown.reduce((a, b) => a + b.used, 0);
    s.rest = s.breakdown.reduce((a, b) => a + b.rest, 0);
    s.month = s.used + s.rest;
  };
  for (const id of IDS) {
    const mine = list.filter((s) => s.provider === id);
    const p = per[id];
    // AWS: bills dipecah per usage type (BoxUsage:t2.micro, EBS:VolumeUsage, PublicIPv4, ...), lalu dicocokkan ke server
    // menurut region dan tipe. Angka diskalakan supaya jumlahnya sama dengan bills bulan ini.
    const usage = p.usage;
    if (usage && usage.length && p.mtd > 0) {
      const scale = p.mtd / usage.reduce((a, u) => a + u.amount, 0);
      const used = new Map(mine.map((s) => [s, {}]));
      let left = 0;
      for (const u of usage) {
        const amt = u.amount * scale;
        const inRegion = mine.filter((s) => s.region === u.region);
        let target = [];
        if (u.cat === 'compute') target = inRegion.filter((s) => !u.type || s.type === u.type);
        else if (u.cat === 'disk' || u.cat === 'snapshot') target = inRegion.filter((s) => s.diskGB > 0);
        else if (u.cat === 'ip') target = inRegion;
        if (!target.length) { left += amt; continue; }
        const w = target.map((s) => (u.cat === 'disk' || u.cat === 'snapshot' ? s.diskGB : 1));
        const ws = w.reduce((a, b) => a + b, 0);
        target.forEach((s, i) => { const b = used.get(s); b[u.cat] = (b[u.cat] || 0) + (amt * w[i]) / ws; });
      }
      mine.forEach((s) => finish(s, used.get(s)));
      if (left > 0.005) unassigned.push({ provider: id, label: LABEL[id], used: left });
      continue;
    }
    // Bobot pembagian: biaya penuh per server (running lebih besar dari stopped). Kalau semua nol, bagi rata.
    const weight = mine.map((s) => s.monthly || 0);
    const wsum = weight.reduce((a, b) => a + b, 0);
    let assigned = 0;
    mine.forEach((s, i) => {
      const share = p.mtd > 0 && mine.length ? (wsum > 0 ? weight[i] / wsum : 1 / mine.length) : 0;
      // Bagian satu server tidak boleh melebihi biaya maksimum yang mungkin untuk tipenya sejak awal bulan.
      const t = pricing.byType(id, s.type);
      const cap = t ? ((t.hourly + pricing.PROVIDERS[id].ipv4Hourly) * 24 + s.daily) * m.day : Infinity;
      const u = Math.min(p.mtd * share, cap);
      assigned += u;
      // Tanpa rincian usage type dari platform: bagi "sudah terpakai" menurut porsi komponen harga server.
      const tot = s.parts.compute + s.parts.disk + s.parts.ip;
      finish(s, tot > 0 ? { compute: (u * s.parts.compute) / tot, disk: (u * s.parts.disk) / tot, ip: (u * s.parts.ip) / tot } : { compute: u });
    });
    const left = p.mtd - assigned;
    if (left > 0.005) unassigned.push({ provider: id, label: LABEL[id], used: left });
  }
  // Hanya instance terdaftar yang dihitung. Bills yang tidak bisa dikaitkan ke instance (server terhapus,
  // region lain, snapshot lepas, IP idle) tidak masuk total. Angka platform disamakan dengan jumlah instance-nya.
  for (const id of IDS) {
    const mine = list.filter((s) => s.provider === id);
    const p = per[id];
    const used = mine.reduce((a, s) => a + s.used, 0);
    const credit = p.mtd > 0 ? Math.min(used, p.creditMtd * (used / p.mtd)) : 0;
    // Grafik harian ikut diskalakan ke porsi instance terdaftar, supaya sama dengan angka di atas.
    // Rasio bulan ini dipakai untuk semua hari di grafik (termasuk bulan lalu), supaya garis tidak loncat di tanggal 1.
    const ratio = p.billed && p.mtd > 0 ? used / p.mtd : p.billed && used === 0 ? 0 : 1;
    if (ratio !== 1) for (const r of p.series) r.total *= ratio;
    p.perDay = mine.reduce((a, s) => a + s.daily, 0);
    p.mtd = used;
    p.creditMtd = credit;
    p.remaining = mine.reduce((a, s) => a + s.rest, 0);
    p.forecastMonth = p.mtd + p.remaining;
  }
  const series = [];
  for (let i = 0; i < n; i++) {
    const row = { date: per.aws.series[i].date, total: 0 };
    for (const id of IDS) {
      row[id] = per[id].series[i].total;
      row.total += row[id];
    }
    series.push(row);
  }
  const projection = [];
  for (let i = 1; i <= m.left; i++) {
    const row = { date: iso(now + i * DAY_MS), proj: true, total: 0 };
    for (const id of IDS) {
      row[id] = per[id].perDay;
      row.total += row[id];
    }
    projection.push(row);
  }
  const sumP = (k) => IDS.reduce((a, id) => a + per[id][k], 0);
  return {
    month: m.month,
    daysLeft: m.left,
    platforms: per,
    series,
    projection,
    servers: list,
    totals: {
      servers: list.length,
      running: list.filter((s) => s.state === 'running').length,
      estMonthly: list.reduce((a, s) => a + s.monthly, 0),
      mtd: sumP('mtd'),
      credit: sumP('creditMtd'),
      remaining: sumP('remaining'),
      parts: IDS.reduce((a, id) => ({ compute: a.compute + per[id].parts.compute, disk: a.disk + per[id].parts.disk, ip: a.ip + per[id].parts.ip }), { compute: 0, disk: 0, ip: 0 }),
      forecast: sumP('forecastMonth'),
      perDay: sumP('perDay'),
    },
    hasData: list.length > 0 || IDS.some((id) => per[id].billed),
  };
}

function status() {
  const out = {};
  for (const id of IDS) out[id] = { id, label: LABEL[id], ...mod(id).publicState() };
  return out;
}

// ---------- analisis ----------
// Anomali = hari lengkap dengan tagihan > 1,5x baseline 14 hari sebelumnya dan selisih > $0.05.
function detectAnomalies({ fromDays = 7, now = Date.now(), ratio = 1.5, minImpact = 0.05 } = {}) {
  const today = iso(now);
  const out = [];
  for (const id of IDS) {
    const days = computeDays(id);
    for (let i = 1; i <= fromDays; i++) {
      const d = iso(now - i * DAY_MS);
      if (d === today || !days[d]) continue;
      const base = [];
      for (let j = 1; j <= 14; j++) {
        const b = days[iso(Date.parse(d) - j * DAY_MS)];
        if (b) base.push(sum(b));
      }
      if (base.length < 3) continue;
      const avg = base.reduce((a, b) => a + b, 0) / base.length;
      const actual = sum(days[d]);
      if (actual - avg > minImpact && actual > avg * ratio) {
        const top = Object.entries(days[d]).sort((a, b) => b[1] - a[1])[0];
        out.push({ id: `${id}-${d}`, provider: id, label: LABEL[id], date: d, expected: avg, actual, impact: actual - avg, service: top ? top[0] : '-' });
      }
    }
  }
  return out.sort((a, b) => b.impact - a.impact);
}

// Peluang hemat dari daftar server, tanpa metrik pemakaian:
//   - server stopped yang masih membayar disk
//   - tipe lain di platform yang sama dengan vCPU dan RAM sama atau lebih, tetapi lebih murah per jam
function savings() {
  const out = [];
  for (const s of servers()) {
    if (s.state === 'stopped' && s.parts.disk > 0) {
      out.push({ kind: 'stopped', server: s, monthly: s.parts.disk, text: `Server stopped, tetapi disk ${s.diskGB} GB tetap ditagih. Hapus atau snapshot kalau tidak dipakai lagi.` });
      continue;
    }
    if (s.state !== 'running' || !s.known) continue;
    const cur = pricing.byType(s.provider, s.type);
    const alt = pricing.PROVIDERS[s.provider].instances
      .filter((i) => i.common && i.arch === cur.arch && i.vcpu >= cur.vcpu && i.memGiB >= cur.memGiB && i.hourly < cur.hourly - 1e-9)
      .sort((a, b) => a.hourly - b.hourly)[0];
    if (alt) {
      const save = (cur.hourly - alt.hourly) * pricing.HOURS_PER_MONTH;
      out.push({ kind: 'resize', server: s, to: alt, monthly: save, text: `Ganti ke ${alt.type} (${alt.vcpu} vCPU, ${alt.memGiB} GiB) dengan spesifikasi setara atau lebih.` });
    }
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

// ---------- planning ----------
const PLAN_ITEMS = {
  server: { label: 'Server', unit: 'server' },
};

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

function itemCost(raw) {
  const p = pricing.PROVIDERS[raw.provider];
  if (!p) throw bad('Platform tidak dikenal');
  const qty = Number(raw.qty ?? 1);
  if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw bad('Jumlah harus antara 0 dan 100000');
  if (raw.kind === 'server') {
    const disk = Number(raw.diskGB ?? 30);
    if (!Number.isFinite(disk) || disk < 0 || disk > 65536) throw bad('Disk harus antara 0 dan 65536 GB');
    const c = pricing.serverMonthly(raw.provider, raw.type, disk);
    if (!c) throw bad(`Tipe server tidak dikenal untuk ${p.label}`);
    return { monthly: c.total * qty, detail: `${raw.type} x ${qty}, disk ${disk} GB` };
  }
  throw bad(`Jenis sumber daya tidak dikenal: ${raw.kind}`);
}

function plan(items, months = 12) {
  const rows = [];
  let monthly = 0;
  for (const raw of items || []) {
    const c = itemCost(raw);
    monthly += c.monthly;
    rows.push({ kind: raw.kind, provider: raw.provider, label: `${PLAN_ITEMS[raw.kind].label} ${LABEL[raw.provider]}`, detail: c.detail, monthly: c.monthly });
  }
  const growth = [];
  for (let i = 1; i <= months; i++) growth.push({ month: i, cumulative: monthly * i });
  return { rows, monthly, yearly: monthly * 12, growth };
}

// Rekomendasi spesifikasi dari kebutuhan dan budget. Aturan tetap (bukan tebakan model):
// kebutuhan vCPU dan RAM dihitung dari jenis aplikasi dan jumlah kunjungan, lalu dicari tipe server
// terkecil yang memenuhi di tiap platform, ditambah satu ukuran lebih besar sebagai cadangan.
const WORKLOADS = {
  landing: { label: 'Website profil', vcpu: 1, mem: 0.5, perVcpu: 0.5, perMem: 0.5, per: 200000, pageMB: 2, note: 'Halaman statis atau CMS ringan, misalnya profil perusahaan atau portofolio.' },
  blog: { label: 'Blog atau CMS', vcpu: 1, mem: 1, perVcpu: 1, perMem: 1, per: 150000, pageMB: 2.5, note: 'WordPress atau sejenisnya, dengan database di server yang sama.' },
  webapp: { label: 'Aplikasi web atau API', vcpu: 2, mem: 2, perVcpu: 1, perMem: 2, per: 100000, pageMB: 1.5, note: 'Backend dan database kecil di server yang sama.' },
  ecommerce: { label: 'Toko online', vcpu: 2, mem: 4, perVcpu: 1, perMem: 2, per: 80000, pageMB: 3, note: 'Membutuhkan RAM lebih untuk cache dan database.' },
  database: { label: 'Server database', vcpu: 2, mem: 8, perVcpu: 1, perMem: 4, per: 100000, pageMB: 0.2, note: 'RAM besar untuk buffer database.' },
  batch: { label: 'Pengolahan data', vcpu: 4, mem: 16, perVcpu: 2, perMem: 4, per: 100000, pageMB: 0.1, note: 'Analitik atau machine learning ringan, lebih banyak CPU.' },
};

// Skala pemakaian menggantikan isian "jumlah kunjungan" yang sulit ditebak pengguna.
// Nilai kunjungan per bulan di sini hanya dipakai internal untuk menghitung kebutuhan dan data transfer.
const SCALES = {
  small: { label: 'Kecil', note: 'Dipakai sendiri, tim kecil, atau tugas kuliah', visits: 5000 },
  medium: { label: 'Sedang', note: 'Usaha kecil atau organisasi, ratusan pengguna per hari', visits: 60000 },
  large: { label: 'Besar', note: 'Layanan publik, ribuan pengguna per hari', visits: 400000 },
};

function requirement(b) {
  const w = WORKLOADS[b.workload];
  if (!w) throw bad('Jenis aplikasi tidak dikenal');
  // Kompatibel dengan versi lama yang mengirim angka kunjungan.
  const scale = SCALES[b.scale] ? b.scale : null;
  const visits = scale ? SCALES[scale].visits : Math.max(0, Number(b.visits) || SCALES.small.visits);
  const steps = Math.floor(visits / w.per);
  const vcpu = Math.ceil(w.vcpu + steps * w.perVcpu);
  const mem = w.mem + steps * w.perMem;
  const storage = Math.max(0, Number(b.storageGB) || 0);
  return {
    workload: w,
    scale: scale || 'small',
    scaleLabel: SCALES[scale || 'small'].label,
    visits,
    vcpu: Math.min(vcpu, 16),
    mem: Math.min(mem, 64),
    diskGB: Math.max(20, Math.ceil(20 + storage)),
    egressGB: Math.round((visits * w.pageMB) / 1024),
    servers: 1,
  };
}

function recommend(b) {
  const budget = Number(b.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000000) throw bad('Budget per bulan harus lebih dari 0');
  const want = (Array.isArray(b.providers) && b.providers.length ? b.providers : IDS).filter((x) => IDS.includes(x));
  if (!want.length) throw bad('Pilih minimal satu platform');
  const arch = ['x86_64', 'arm64'].includes(b.arch) ? b.arch : 'any';
  const req = requirement(b);
  const options = [];
  for (const id of want) {
    const p = pricing.PROVIDERS[id];
    const fit = p.instances
      .filter((i) => i.common && (arch === 'any' || i.arch === arch) && i.vcpu >= req.vcpu && i.memGiB >= req.mem * 0.95)
      .sort((a, b2) => a.hourly - b2.hourly);
    // Ukuran pas dan satu ukuran cadangan (RAM atau vCPU lebih besar) dari platform yang sama.
    const picks = [];
    if (fit[0]) picks.push({ t: fit[0], tier: 'pas' });
    const roomy = fit.find((i) => i.memGiB > fit[0]?.memGiB || i.vcpu > fit[0]?.vcpu);
    if (roomy) picks.push({ t: roomy, tier: 'cadangan' });
    for (const { t, tier } of picks) {
      const srv = pricing.serverMonthly(id, t.type, req.diskGB);
      const total = srv.total * req.servers;
      options.push({
        provider: id,
        label: LABEL[id],
        region: p.region,
        type: t.type,
        vcpu: t.vcpu,
        memGiB: t.memGiB,
        arch: t.arch,
        tier,
        count: req.servers,
        diskGB: req.diskGB,
        parts: { server: srv.compute * req.servers, disk: srv.disk * req.servers, ip: srv.ip * req.servers },
        monthly: total,
        fits: total <= budget,
        left: budget - total,
        items: [{ kind: 'server', provider: id, type: t.type, qty: req.servers, diskGB: req.diskGB }],
      });
    }
  }
  // Urutan: yang masuk budget dulu. Di antara yang masuk budget, ukuran cadangan didahulukan kalau sisa budget
  // masih cukup, karena memberi ruang tumbuh. Selebihnya diurutkan dari biaya.
  options.sort((a, b2) => (a.fits !== b2.fits ? (a.fits ? -1 : 1) : a.monthly - b2.monthly));
  const fitting = options.filter((o) => o.fits);
  let best = fitting[0] || null;
  const reasons = [];
  if (best) {
    reasons.push(`Kebutuhan minimum ${req.vcpu} vCPU dan ${req.mem} GiB RAM untuk ${req.workload.label.toLowerCase()} skala ${req.scaleLabel.toLowerCase()}.`);
    reasons.push(`${best.type} menyediakan ${best.vcpu} vCPU dan ${best.memGiB} GiB, ${best.tier === 'cadangan' ? 'satu tingkat di atas kebutuhan' : 'ukuran terkecil yang memenuhi kebutuhan'}.`);
    reasons.push(`Biaya ${best.monthly.toFixed(2)} USD per bulan, sisa budget ${best.left.toFixed(2)} USD.`);
  }
  return { budget, requirement: { ...req, workload: b.workload, workloadLabel: req.workload.label }, best, options, cheapestGap: best ? null : options[0] ? options[0].monthly - budget : null, reasons };
}

module.exports = { IDS, LABEL, servers, summarize, overview, status, detectAnomalies, savings, plan, recommend, PLAN_ITEMS, WORKLOADS, SCALES, computeDays, monthInfo, iso, DAY_MS };
