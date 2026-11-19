'use strict';
// Rule-based FinOps agent untuk server di AWS, Azure, dan Google Cloud.
// Format balasan: { title, steps: [string], blocks: [{type, ...}] }
//   p {text}, h {text}, ul {items}, table {columns, rows}, stats {items}, chart {kind,...}, follow {items}
//   Teks mendukung **tebal** dan `kode`.
const store = require('./store');
const pricing = require('./pricing');
const cloud = require('./cloud');
const budget = require('./budget');

const usd = (n, d = 2) => {
  if (Math.abs(n) < 0.00005) n = 0;
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 && d < 3 ? 4 : d;
  return (n < 0 ? '-$' : '$') + abs.toFixed(digits);
};
const STATE = { running: 'running', stopped: 'stopped' };

function parseDays(text, def) {
  const m = text.match(/(\d{1,3})\s*(d\b|day|days|hari)/i);
  if (m) return Math.min(30, Math.max(1, Number(m[1])));
  if (/\b(week|minggu)\b/i.test(text)) return 7;
  if (/\b(yesterday|kemarin)\b/i.test(text)) return 1;
  return def;
}
function wantProvider(text) {
  if (/azure/i.test(text)) return 'azure';
  if (/gcp|google/i.test(text)) return 'gcp';
  if (/\baws\b|amazon|ec2/i.test(text)) return 'aws';
  return null;
}

function noData() {
  return {
    title: 'Belum ada server',
    steps: ['Mengecek akun cloud yang tersambung'],
    blocks: [
      { type: 'p', text: 'Belum ada server terdaftar dari AWS, Azure, atau Google Cloud, jadi belum ada biaya untuk dianalisis.' },
      { type: 'p', text: 'Buka **Integrations**, sambungkan akun cloud dengan kredensial read-only, lalu klik **Simpan**. Untuk menghitung biaya tanpa server, pakai halaman **Planning**.' },
      { type: 'follow', items: ['Rekomendasi server untuk web dengan budget $20', 'Tampilkan harga'] },
    ],
  };
}

// ---------- intents ----------

function costSummary(text) {
  const o = cloud.overview(30);
  const only = wantProvider(text);
  const ids = only ? [only] : cloud.IDS;
  const list = o.servers.filter((s) => ids.includes(s.provider));
  const est = list.reduce((a, s) => a + s.monthly, 0);
  const mtd = ids.reduce((a, id) => a + o.platforms[id].mtd, 0);
  const blocks = [
    { type: 'p', text: `Ada **${list.length} server** terdaftar${only ? ` di **${cloud.LABEL[only]}**` : ''}, ${list.filter((s) => s.state === 'running').length} di antaranya running. Biaya bulan berjalan **${usd(mtd)}**, dengan estimasi **${usd(est)} per bulan** kalau kondisi server tetap seperti sekarang.` },
    { type: 'stats', items: [{ label: 'Bulan berjalan', value: usd(mtd) }, { label: 'Estimasi per bulan', value: usd(est) }, { label: 'Server running', value: `${list.filter((s) => s.state === 'running').length} dari ${list.length}` }] },
  ];
  const slices = ids.map((id) => ({ label: cloud.LABEL[id], value: o.servers.filter((s) => s.provider === id).reduce((a, s) => a + s.monthly, 0) })).filter((s) => s.value > 0);
  if (slices.length > 1) blocks.push({ type: 'chart', kind: 'donut', title: 'Estimasi per bulan per platform', slices });
  const top = [...list].sort((a, b) => b.monthly - a.monthly).slice(0, 8);
  if (top.length) {
    blocks.push({ type: 'chart', kind: 'hbars', title: 'Server dengan estimasi biaya terbesar', rows: top.map((s) => ({ label: s.name, value: s.monthly })) });
    blocks.push({
      type: 'table',
      columns: ['Server', 'Platform', 'Tipe', 'Status', 'Per bulan'],
      rows: top.map((s) => [s.name, cloud.LABEL[s.provider], `\`${s.type}\``, STATE[s.state] || s.state, usd(s.monthly)]),
    });
  }
  const billed = ids.filter((id) => o.platforms[id].billed);
  if (billed.length) blocks.push({ type: 'p', text: `Biaya bulan berjalan untuk ${billed.map((id) => cloud.LABEL[id]).join(', ')} memakai bills. Platform lain memakai estimasi dari harga server.` });
  blocks.push({ type: 'follow', items: ['Forecast bulan ini', 'Cari peluang hemat', 'Daftar server'] });
  return { title: 'Ringkasan biaya server', steps: ['Membaca daftar server dari semua platform', 'Menghitung estimasi dari daftar harga on-demand', 'Menggabungkan dengan bills yang tersedia'], blocks };
}

function forecastIntent() {
  const o = cloud.overview(30);
  const b = budget.status(o.totals);
  const rows = [];
  let acc = o.totals.mtd;
  rows.push({ date: o.series[o.series.length - 1].date, v: acc });
  for (const p of o.projection) {
    acc += p.total;
    rows.push({ date: p.date, v: acc, proj: true });
  }
  const blocks = [
    { type: 'p', text: `Perkiraan biaya server sampai akhir bulan **${usd(o.totals.forecast)}**. Sudah terpakai ${usd(o.totals.mtd)}, dengan rata-rata ${usd(o.totals.perDay)} per hari untuk ${o.daysLeft} hari lagi.` },
    { type: 'stats', items: [{ label: 'Terpakai bulan ini', value: usd(o.totals.mtd) }, { label: 'Per hari', value: usd(o.totals.perDay) }, { label: 'Perkiraan akhir bulan', value: usd(o.totals.forecast) }] },
  ];
  if (rows.length > 1) blocks.push({ type: 'chart', kind: 'line', title: 'Biaya kumulatif sampai akhir bulan', rows, ref: b.amount > 0 ? { value: b.amount, label: `budget ${usd(b.amount)}` } : null });
  if (b.amount > 0) {
    blocks.push({
      type: 'p',
      text: b.over
        ? `Perkiraan ini **${b.pctForecast.toFixed(0)}% dari budget ${usd(b.amount)}**, lebih sekitar ${usd(o.totals.forecast - b.amount)}.`
        : `Perkiraan ini ${b.pctForecast.toFixed(0)}% dari budget ${usd(b.amount)}. Masih di bawah budget.`,
    });
  }
  blocks.push({ type: 'table', columns: ['Platform', 'Terpakai', 'Per hari', 'Akhir bulan'], rows: cloud.IDS.map((id) => { const p = o.platforms[id]; return [p.label, usd(p.mtd), usd(p.perDay), usd(p.forecastMonth)]; }) });
  blocks.push({ type: 'follow', items: ['Cari peluang hemat', 'Berapa budget saya?'] });
  return { title: 'Forecast biaya', steps: ['Menghitung biaya bulan berjalan per platform', 'Menghitung biaya per hari dari kondisi server sekarang', 'Memproyeksikan sampai akhir bulan'], blocks };
}

function anomalies(text) {
  const days = parseDays(text, 7);
  const found = cloud.detectAnomalies({ fromDays: days });
  const billedIds = cloud.IDS.filter((id) => cloud.summarize(id).billed);
  const blocks = [];
  if (!billedIds.length) {
    blocks.push({ type: 'p', text: 'Deteksi lonjakan butuh bills harian, dan bills belum tersedia di platform mana pun.' });
  } else if (!found.length) {
    blocks.push({ type: 'p', text: `Tidak ada lonjakan biaya dalam **${days} hari terakhir** di ${billedIds.map((id) => cloud.LABEL[id]).join(', ')}.` });
  } else {
    blocks.push({ type: 'p', text: `Ada **${found.length} lonjakan biaya** dalam ${days} hari terakhir.` });
    blocks.push({ type: 'table', columns: ['Tanggal', 'Platform', 'Layanan terbesar', 'Normal', 'Aktual', 'Selisih'], rows: found.map((a) => [a.date, a.label, a.service, usd(a.expected), usd(a.actual), usd(a.impact)]) });
  }
  blocks.push({ type: 'follow', items: ['Forecast bulan ini', 'Daftar server'] });
  return { title: 'Lonjakan biaya', steps: [`Rentang ${days} hari terakhir`, 'Membandingkan tiap hari dengan rata-rata 14 hari sebelumnya', 'Menandai hari di atas 1,5x rata-rata dan selisih lebih dari $0.05'], blocks };
}

function savingsIntent() {
  const list = cloud.savings();
  const total = list.reduce((a, s) => a + s.monthly, 0);
  const blocks = [];
  if (!list.length) {
    blocks.push({ type: 'p', text: 'Tidak ada peluang hemat yang terlihat dari daftar server: tidak ada server stopped yang masih membayar disk, dan setiap server sudah memakai tipe dengan harga per jam terendah untuk spesifikasinya.' });
  } else {
    blocks.push({ type: 'p', text: `Ada **${list.length} peluang hemat** dengan total sekitar **${usd(total)} per bulan**.` });
    blocks.push({ type: 'chart', kind: 'hbars', title: 'Potensi hemat per bulan', rows: list.slice(0, 8).map((s) => ({ label: s.server.name, value: s.monthly })) });
    blocks.push({ type: 'table', columns: ['Server', 'Platform', 'Saat ini', 'Saran', 'Hemat per bulan'], rows: list.map((s) => [s.server.name, cloud.LABEL[s.server.provider], `\`${s.server.type}\``, s.text, usd(s.monthly)]) });
  }
  blocks.push({ type: 'follow', items: ['Forecast bulan ini', 'Daftar server'] });
  return { title: 'Peluang hemat', steps: ['Mencari server stopped yang masih membayar disk', 'Membandingkan tipe server dengan tipe lain yang spesifikasinya setara di platform yang sama'], blocks };
}

function serverList(text) {
  const only = wantProvider(text);
  const list = cloud.servers(only);
  return {
    title: 'Daftar server',
    steps: ['Membaca daftar server hasil sinkron terakhir'],
    blocks: [
      { type: 'p', text: `${list.length} server${only ? ` di ${cloud.LABEL[only]}` : ''}.` },
      { type: 'table', columns: ['Server', 'Platform', 'Lokasi', 'Tipe', 'Spesifikasi', 'Status', 'Per bulan'], rows: list.map((s) => [s.name, cloud.LABEL[s.provider], s.location, `\`${s.type}\``, s.vcpu ? `${s.vcpu} vCPU, ${s.memGiB} GiB, ${s.diskGB} GB` : `${s.diskGB} GB disk`, STATE[s.state] || s.state, usd(s.monthly)]) },
      { type: 'follow', items: ['Cari peluang hemat', 'Ringkasan biaya'] },
    ],
  };
}

function budgetIntent() {
  const o = cloud.overview(30);
  const b = budget.status(o.totals);
  return {
    title: 'Budget bulanan',
    steps: ['Membaca budget bulanan', 'Membandingkan dengan biaya bulan berjalan dan perkiraan akhir bulan'],
    blocks: [
      { type: 'stats', items: [{ label: 'Budget per bulan', value: usd(b.amount) }, { label: 'Terpakai', value: usd(b.used) }, { label: 'Sisa', value: usd(b.remaining) }] },
      { type: 'p', text: b.amount > 0 ? `Perkiraan akhir bulan ${usd(b.forecast)}, atau ${b.pctForecast.toFixed(0)}% dari budget.${b.over ? ' Ini melebihi budget.' : ''}` : 'Budget belum diatur. Atur di Dashboard.' },
      { type: 'follow', items: ['Forecast bulan ini', 'Cari peluang hemat'] },
    ],
  };
}

function pricingIntent(text) {
  const only = wantProvider(text) || 'aws';
  const p = pricing.PROVIDERS[only];
  return {
    title: `Harga ${p.label}`,
    steps: [`Memuat daftar harga on-demand ${p.region.code}`],
    blocks: [
      { type: 'p', text: `Harga on-demand Linux **${p.product}** di **${p.region.name}**. Disk ${p.diskLabel} ${usd(p.diskPerGBMonth, 3)} per GB-bulan, IPv4 publik ${usd(p.ipv4Hourly, 3)} per jam.` },
      { type: 'table', columns: ['Tipe', 'Arch', 'vCPU', 'RAM (GiB)', 'Per jam', 'Per bulan'], rows: p.instances.map((i) => [`\`${i.type}\``, i.arch, i.vcpu, i.memGiB, usd(i.hourly, 4), usd(i.hourly * pricing.HOURS_PER_MONTH)]) },
      { type: 'follow', items: cloud.IDS.filter((x) => x !== only).map((x) => `Tampilkan harga ${cloud.LABEL[x]}`) },
    ],
  };
}

// "rekomendasi server untuk toko online budget $30 5000 kunjungan"
function recommendIntent(text) {
  const t = text.toLowerCase();
  const money = t.match(/\$\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(usd|dolar|dollar)/);
  const amount = money ? Number((money[1] || money[2]).replace(',', '.')) : 25;
  const visits = Number((t.match(/(\d[\d.]*)\s*(kunjungan|visit|pengunjung|user)/)?.[1] || '10000').replace(/\./g, ''));
  const workload = /toko|shop|commerce/.test(t) ? 'ecommerce' : /blog|wordpress|cms/.test(t) ? 'blog' : /database|db\b/.test(t) ? 'database' : /api|aplikasi|app/.test(t) ? 'webapp' : /ml|machine|data/.test(t) ? 'batch' : 'landing';
  const r = cloud.recommend({ budget: amount, visits, workload, providers: wantProvider(text) ? [wantProvider(text)] : undefined });
  const blocks = [];
  if (r.best) {
    blocks.push({ type: 'p', text: `Untuk **${r.requirement.workloadLabel.toLowerCase()}** dengan sekitar ${visits.toLocaleString('id-ID')} kunjungan per bulan dan budget **${usd(amount)}**, pilihan yang disarankan **${r.best.label} \`${r.best.type}\`** seharga **${usd(r.best.monthly)} per bulan**.` });
    blocks.push({ type: 'ul', items: r.reasons });
  } else {
    blocks.push({ type: 'p', text: `Budget ${usd(amount)} belum cukup. Pilihan terdekat kurang sekitar ${usd(r.cheapestGap)} per bulan.` });
  }
  blocks.push({ type: 'chart', kind: 'hbars', title: 'Perbandingan biaya per bulan', rows: r.options.slice(0, 6).map((o) => ({ label: `${o.label} ${o.type}`, value: o.monthly })), ref: amount });
  blocks.push({ type: 'p', text: 'Buka **Planning** untuk mengubah kebutuhan dan budget dengan form lengkap.' });
  blocks.push({ type: 'follow', items: ['Tampilkan harga AWS', 'Forecast bulan ini'] });
  return { title: 'Rekomendasi server', steps: ['Membaca jenis aplikasi, kunjungan, dan budget dari pertanyaan', `Kebutuhan minimal ${r.requirement.vcpu} vCPU dan ${r.requirement.mem} GiB RAM`, 'Mencari tipe server yang memenuhi di tiap platform', 'Mengurutkan dari yang sesuai budget'], blocks };
}

function help() {
  return {
    title: 'VPS FinOps Agent',
    steps: ['Tidak ada intent yang cocok'],
    blocks: [
      { type: 'p', text: 'Saya bisa bantu soal biaya server di AWS, Azure, dan Google Cloud. Coba salah satu:' },
      { type: 'follow', items: ['Ringkasan biaya', 'Forecast bulan ini', 'Cari peluang hemat', 'Daftar server', 'Cek lonjakan biaya 7 hari', 'Rekomendasi server untuk toko online budget $30'] },
    ],
  };
}

// Tools yang bisa dipanggil agent atau model AI. Semua angka berasal dari fungsi deterministik ini.
const TOOLS = {
  recommend_server: { fn: recommendIntent, needsData: false, desc: 'Rekomendasi tipe server dari kebutuhan aplikasi dan budget', re: /rekomendasi server|sarankan|pilihkan|cocok untuk|butuh server|mau bikin|budget \$|spek/i },
  get_pricing: { fn: pricingIntent, needsData: false, desc: 'Daftar harga server on-demand AWS, Azure, atau Google Cloud', re: /pric|harga|tarif/i },
  get_budget: { fn: budgetIntent, needsData: false, desc: 'Budget bulanan, terpakai, dan sisa', re: /budget|anggaran|saldo|sisa/i },
  detect_anomalies: { fn: anomalies, needsData: true, desc: 'Lonjakan bills harian dalam N hari terakhir', re: /anomal|spike|lonjak|aneh/i },
  find_savings: { fn: savingsIntent, needsData: true, desc: 'Peluang hemat: server stopped yang masih bayar disk, tipe setara yang lebih hemat', re: /hemat|saving|optimi|rightsiz|idle|rekomendasi/i },
  get_forecast: { fn: forecastIntent, needsData: true, desc: 'Perkiraan biaya akhir bulan dibanding budget', re: /forecast|prediksi|perkiraan|proyeksi|akhir bulan/i },
  list_servers: { fn: serverList, needsData: true, desc: 'Daftar server terdaftar dengan tipe, status, dan biaya', re: /daftar|list|server|instance|vm\b|status/i },
  get_cost_summary: { fn: costSummary, needsData: true, desc: 'Ringkasan biaya server per platform', re: /cost|biaya|bill|tagihan|pengeluaran|ringkas/i },
  help: { fn: help, needsData: false, desc: 'Sapaan atau pertanyaan di luar topik', re: null },
};

function routeRule(text) {
  const t = String(text || '');
  return Object.keys(TOOLS).find((k) => TOOLS[k].re && TOOLS[k].re.test(t)) || 'help';
}

function runTool(name, text) {
  const tool = TOOLS[name] || TOOLS.help;
  if (tool.needsData && !cloud.overview(1).hasData) return noData();
  return tool.fn(String(text || ''));
}

function respond(text) {
  return runTool(routeRule(text), text);
}

module.exports = { respond, routeRule, runTool, TOOLS, usd };
