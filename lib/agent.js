'use strict';
// Rule-based FinOps agent. Answers from AWS-priced cost data of connected VPS.
// Reply format: { title, steps: [string], blocks: [{type, ...}] }
//   block types: p {text}, h {text}, ul {items}, table {columns, rows}
//   text supports **bold** and `code`.
// User-facing text is Indonesian; IT terms stay in English.
const store = require('./store');
const costs = require('./costs');
const pricing = require('./pricing');
const demo = require('./demo');
const aws = require('./aws');
const cloud = require('./cloud');

const usd = (n, d = 2) => {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 && d < 3 ? 6 : d;
  return (n < 0 ? '-$' : '$') + abs.toFixed(digits);
};

function parseDays(text, def) {
  const m = text.match(/(\d{1,3})\s*(d\b|day|days|hari)/i);
  if (m) return Math.min(90, Math.max(1, Number(m[1])));
  if (/\b(week|minggu)\b/i.test(text)) return 7;
  if (/\b(month|bulan)\b/i.test(text)) return 30;
  if (/\b(yesterday|kemarin)\b/i.test(text)) return 1;
  return def;
}

function findVps(text) {
  const t = text.toLowerCase();
  return store.db.vps.find((v) => t.includes(v.name.toLowerCase()) || (v.last?.hostname && t.includes(v.last.hostname.toLowerCase()))) || null;
}

function budgetFromContext() {
  for (const f of store.db.contextFiles) {
    const m = f.content.match(/budget\s*[:=]\s*\$?\s*(\d+(?:\.\d+)?)/i);
    if (m) return { amount: Number(m[1]), source: f.name };
  }
  const a = store.db.automations.find((x) => x.type === 'budget');
  return a ? { amount: Number(a.params.monthlyBudgetUsd) || 0, source: `automation "${a.name}"` } : null;
}

function noVps() {
  return {
    title: 'Belum ada VPS',
    steps: ['Mengecek daftar VPS terhubung: 0 ditemukan'],
    blocks: [
      { type: 'p', text: 'Belum ada VPS yang terhubung, jadi belum ada data biaya untuk dianalisis.' },
      { type: 'p', text: 'Buka **Integrations** di sidebar, klik **Connect VPS**, lalu jalankan perintah install di server kamu. Data akan masuk dalam satu menit.' },
    ],
  };
}

// ---------- intents ----------

function anomalies(text, opts = {}) {
  const days = opts.days || parseDays(text, 7);
  const now = Date.now();
  const from = costs.dayKey(now - days * 86400000);
  const to = costs.dayKey(now);
  const steps = [
    `Menentukan rentang waktu: ${days} hari terakhir (${from} sampai ${to})`,
    'Memuat data biaya harian setiap VPS',
    'Menghitung baseline 14 hari per VPS dan service',
    'Menandai hari dengan biaya > 1,5x baseline dan dampak > $0.05',
  ];
  const found = costs.detectAnomalies({ fromDays: days });
  const history = costs.detectAnomalies({ fromDays: 90 }).filter((a) => a.date < from);
  const series = costs.dailySeries(costs.daysBack(21));
  const sum21 = series.reduce((a, r) => a + r.total, 0);
  const nonZero = series.filter((r) => r.total > 0);
  const lo = nonZero.length ? Math.min(...nonZero.map((r) => r.total)) : 0;
  const hi = nonZero.length ? Math.max(...nonZero.map((r) => r.total)) : 0;
  steps.push('Mengecek riwayat anomali 90 hari', 'Mencari event agent (reboot, resize, outage) di sekitar setiap anomali');

  const blocks = [];
  if (!found.length) {
    blocks.push({ type: 'p', text: `Saya **tidak menemukan anomali biaya dalam ${days} hari terakhir** (${from} sampai ${to}), jadi tidak ada event yang perlu dikorelasikan untuk periode itu.` });
  } else {
    blocks.push({ type: 'p', text: `Saya menemukan **${found.length} anomali biaya dalam ${days} hari terakhir** (${from} sampai ${to}).` });
  }
  blocks.push({ type: 'h', text: 'Yang saya cek' });
  blocks.push({
    type: 'ul',
    items: [
      `**Deteksi anomali, ${from} – ${to}:** ${found.length} anomali.`,
      `**Biaya harian, 21 hari terakhir:** ${nonZero.length ? `berkisar ${usd(lo)} sampai ${usd(hi)} per hari, total 21 hari ${usd(sum21)}.` : 'belum ada biaya tercatat.'}`,
      `**Riwayat anomali (90 hari):** ${history.length} anomali sebelumnya.`,
    ],
  });

  const all = [...found, ...history.slice(0, 5)];
  if (all.length) {
    blocks.push({
      type: 'table',
      columns: ['Anomaly ID', 'Tanggal', 'VPS', 'Service', 'Perkiraan', 'Aktual', 'Dampak'],
      rows: all.map((a) => [`\`${a.id}\``, a.date, a.vpsName, a.service, usd(a.expected), usd(a.actual), usd(a.impact)]),
    });
  }

  for (const a of found.slice(0, 3)) {
    const ev = costs.eventsAround(a.vpsId, a.date);
    blocks.push({ type: 'h', text: `Event di sekitar ${a.vpsName} pada ${a.date}` });
    if (!ev.length) {
      blocks.push({ type: 'p', text: 'Tidak ada event agent (reboot, resize, outage) dalam ±1 hari. Kenaikan berasal dari pemakaian, bukan perubahan konfigurasi.' });
    } else {
      blocks.push({
        type: 'table',
        columns: ['Waktu (UTC)', 'Event', 'Detail'],
        rows: ev.map((e) => [new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19), e.type, e.detail]),
      });
    }
    if (a.serviceKey === 'egress') {
      blocks.push({ type: 'p', text: 'Penyebabnya traffic keluar (outbound). Cek proses yang mengirim data dengan `sudo nethogs` atau `sudo iftop` di VPS.' });
    } else if (a.serviceKey === 'compute') {
      blocks.push({ type: 'p', text: 'Biaya compute naik karena VPS di-resize ke instance yang lebih besar, atau berjalan lebih lama dari baseline.' });
    }
  }
  if (!found.length && history.length) {
    blocks.push({ type: 'p', text: 'Kalau mau, tanyakan salah satu anomali lama berdasarkan tanggalnya, nanti saya tampilkan event di sekitarnya.' });
  }
  blocks.push({ type: 'follow', items: ['Tampilkan biaya 30 hari terakhir', 'Forecast bulan ini'] });
  return { title: 'Investigasi Anomali Biaya', steps, blocks };
}

function costSummary(text, opts = {}) {
  const days = opts.days || parseDays(text, 30);
  const v = findVps(text);
  const series = costs.dailySeries(costs.daysBack(days), v?.id);
  const tot = series.reduce(
    (a, r) => ({ total: a.total + r.total, compute: a.compute + r.compute, storage: a.storage + r.storage, ipv4: a.ipv4 + r.ipv4, egress: a.egress + r.egress }),
    { total: 0, compute: 0, storage: 0, ipv4: 0, egress: 0 }
  );
  const steps = [
    `Menentukan rentang waktu: ${days} hari terakhir${v ? `, VPS "${v.name}"` : ', semua VPS'}`,
    `Menjumlahkan biaya harian dengan harga AWS ${pricing.REGION.code} on-demand`,
    'Mengelompokkan per service',
  ];
  const blocks = [
    { type: 'p', text: `Total biaya **${days} hari terakhir**${v ? ` untuk **${v.name}**` : ''} adalah **${usd(tot.total)}** (harga AWS ${pricing.REGION.name}).` },
    {
      type: 'table',
      columns: ['Service', 'Biaya', 'Porsi'],
      rows: Object.entries(costs.SERVICES).map(([k, name]) => [name, usd(tot[k]), tot.total ? ((tot[k] / tot.total) * 100).toFixed(1) + '%' : '0%']),
    },
  ];
  if (!v && store.db.vps.length > 1) {
    steps.push('Mengelompokkan per VPS');
    blocks.push({ type: 'h', text: 'Per VPS' });
    blocks.push({
      type: 'table',
      columns: ['VPS', 'Setara instance', 'Biaya'],
      rows: store.db.vps.map((x) => {
        const c = costs.dailySeries(costs.daysBack(days), x.id).reduce((a, r) => a + r.total, 0);
        return [x.name, `\`${costs.effectiveType(x)?.type || '-'}\``, usd(c)];
      }),
    });
  }
  if (tot.total > 0) {
    const daily = series.map((r) => ({ date: r.date, compute: r.compute, storage: r.storage, ipv4: r.ipv4, egress: r.egress }));
    blocks.splice(1, 0, {
      type: 'stats',
      items: [
        { label: `Total ${days} hari`, value: usd(tot.total) },
        { label: 'Rata-rata per hari', value: usd(tot.total / days) },
        { label: 'Hari termahal', value: usd(Math.max(...series.map((r) => r.total))) },
      ],
    });
    blocks.splice(2, 0, {
      type: 'chart',
      kind: 'bars',
      title: `Biaya harian, ${days} hari terakhir`,
      series: [{ key: 'compute', label: 'EC2 compute' }, { key: 'storage', label: 'EBS gp3' }, { key: 'ipv4', label: 'Public IPv4' }, { key: 'egress', label: 'Data transfer out' }],
      rows: daily,
    });
    blocks.splice(3, 0, {
      type: 'chart',
      kind: 'donut',
      title: 'Porsi per layanan',
      slices: Object.entries(costs.SERVICES).map(([k, name]) => ({ label: name, value: tot[k] })).filter((s) => s.value > 0),
    });
  }
  blocks.push({ type: 'follow', items: ['Cek anomali biaya 7 hari terakhir', 'Forecast bulan ini', 'Rekomendasi rightsizing'] });
  return { title: 'Ringkasan Biaya', steps, blocks };
}

function forecastIntent() {
  const f = costs.forecast();
  const b = budgetFromContext();
  const steps = ['Menghitung biaya bulan berjalan', 'Menghitung run rate per jam dari VPS online + rata-rata egress 7 hari', 'Memproyeksikan sampai akhir bulan'];
  const blocks = [
    {
      type: 'ul',
      items: [
        `**Bulan berjalan:** ${usd(f.mtd)}`,
        `**Run rate saat ini:** ${usd(f.runRatePerHour, 4)}/jam (${usd(f.runRatePerHour * 24)}/hari)`,
        `**Forecast bulan ini:** ${usd(f.forecast)}`,
      ],
    },
  ];
  if (b && b.amount > 0) {
    steps.push(`Membandingkan dengan budget dari ${b.source}`);
    const pct = (f.forecast / b.amount) * 100;
    blocks.push({
      type: 'p',
      text: pct > 100
        ? `Forecast mencapai **${pct.toFixed(0)}% dari budget ${usd(b.amount)}** (dari ${b.source}). Perkiraan melebihi budget sekitar ${usd(f.forecast - b.amount)}.`
        : `Forecast mencapai ${pct.toFixed(0)}% dari budget ${usd(b.amount)} (dari ${b.source}). Masih sesuai budget.`,
    });
  }
  const samples = store.db.vps.filter((v) => v.demo);
  if (samples.length) {
    steps.push('Menghitung proyeksi VPS sample AWS');
    blocks.push({ type: 'h', text: 'Proyeksi VPS sample AWS' });
    blocks.push({
      type: 'table',
      columns: ['VPS', 'Instance', 'Disk', 'Proyeksi/bulan', 'Masuk forecast'],
      rows: samples.map((v) => [
        v.name,
        `\`${v.instanceType}\``,
        `${(v.last?.diskTotalGB || 0).toFixed(0)} GB`,
        usd(demo.projectedMonthly(v.instanceType, v.last?.diskTotalGB || 0)),
        v.active ? 'ya' : 'tidak (klik Aktifkan proyeksi)',
      ]),
    });
  }
  const rows = [];
  const endDay = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
  let acc = f.mtd;
  for (let i = 1; i <= Math.max(0, endDay - new Date().getUTCDate()); i++) {
    acc += f.runRatePerHour * 24;
    rows.push({ date: new Date(Date.now() + i * 86400000).toISOString().slice(0, 10), v: acc, proj: true });
  }
  if (rows.length && f.runRatePerHour > 0) {
    blocks.splice(1, 0, {
      type: 'stats',
      items: [
        { label: 'Terpakai bulan ini', value: usd(f.mtd) },
        { label: 'Per hari saat ini', value: usd(f.runRatePerHour * 24) },
        { label: 'Perkiraan akhir bulan', value: usd(f.forecast) },
      ],
    });
    blocks.splice(2, 0, {
      type: 'chart',
      kind: 'line',
      title: 'Biaya kumulatif sampai akhir bulan (perkiraan)',
      rows,
      ref: b && b.amount > 0 ? { value: b.amount, label: `budget ${usd(b.amount)}` } : null,
    });
  }
  blocks.push({ type: 'follow', items: ['Tampilkan biaya 30 hari terakhir', 'Rekomendasi rightsizing', 'Berapa sisa anggaran saya?'] });
  return { title: 'Forecast Biaya', steps, blocks };
}

function rightsizingIntent(text) {
  const v = findVps(text);
  const list = (v ? [v] : store.db.vps).map(costs.rightsize).filter(Boolean);
  const steps = ['Memuat metrik CPU dan memory 14 hari', 'Menentukan ukuran tiap VPS: peak memory +25% dan peak CPU ≤70%', `Memilih instance yang paling pas dengan kebutuhan di ${pricing.REGION.code}`];
  const ready = list.filter((r) => r.enoughData);
  const notReady = list.filter((r) => !r.enoughData);
  const blocks = [];
  if (ready.length) {
    const total = ready.reduce((a, r) => a + r.monthlySavings, 0);
    blocks.push({ type: 'p', text: total > 0 ? `Kamu bisa hemat sekitar **${usd(total)}/bulan** dengan resize.` : 'Semua VPS yang datanya cukup sudah berukuran pas.' });
    blocks.push({
      type: 'table',
      columns: ['VPS', 'Saat ini', 'Rata-rata CPU', 'Peak CPU', 'Peak RAM', 'Rekomendasi', 'Hemat/bulan'],
      rows: ready.map((r) => [
        r.vps.name,
        `\`${r.current.type}\``,
        r.stats.cpuAvg.toFixed(1) + '%',
        r.stats.cpuMax.toFixed(1) + '%',
        r.stats.memUsedMaxGiB.toFixed(2) + ' GiB',
        `\`${r.recommended.type}\``,
        usd(r.monthlySavings),
      ]),
    });
    const idle = ready.filter((r) => r.idle);
    if (idle.length) blocks.push({ type: 'p', text: `**Idle:** ${idle.map((r) => r.vps.name).join(', ')} memakai CPU di bawah 5% selama 14 hari. Pertimbangkan untuk dimatikan.` });
  }
  if (notReady.length) {
    blocks.push({ type: 'p', text: `Data belum cukup (butuh 24 jam) untuk: ${notReady.map((r) => r.vps.name).join(', ')}.` });
  }
  blocks.push({ type: 'follow', items: ['Forecast bulan ini', 'Status VPS'] });
  return { title: 'Rekomendasi Rightsizing', steps, blocks };
}

function balanceIntent() {
  const b = costs.balance();
  const f = costs.forecast();
  const daysLeft = f.runRatePerHour > 0 ? b.remaining / (f.runRatePerHour * 24) : Infinity;
  return {
    title: 'Saldo Kredit',
    steps: ['Membaca kredit dan top-up', 'Menjumlahkan semua biaya', 'Memperkirakan sisa waktu dengan run rate saat ini'],
    blocks: [
      {
        type: 'ul',
        items: [
          `**Total kredit:** ${usd(b.credit)}`,
          `**Terpakai:** ${usd(b.spent)}`,
          `**Sisa:** ${usd(b.remaining)}`,
          `**Cukup untuk:** ${Number.isFinite(daysLeft) ? `sekitar ${Math.floor(daysLeft)} hari dengan ${usd(f.runRatePerHour * 24)}/hari` : 'tidak ada biaya berjalan saat ini'}`,
        ],
      },
    ],
  };
}

function vpsStatus() {
  const now = Date.now();
  return {
    title: 'Status VPS',
    steps: ['Membaca daftar VPS terhubung', 'Mengecek heartbeat terakhir masing-masing'],
    blocks: [
      {
        type: 'table',
        columns: ['VPS', 'Status', 'Host', 'Spesifikasi', 'Setara instance', '$/jam', 'CPU', 'RAM'],
        rows: store.db.vps.map((v) => {
          const t = costs.effectiveType(v);
          const l = v.last;
          return [
            v.name,
            v.demo ? (v.active ? 'sample AWS (proyeksi aktif)' : 'sample AWS') : !v.lastSeen ? 'menunggu agent' : costs.isOnline(v, now) ? 'online' : 'offline',
            l?.hostname || '-',
            l ? `${l.vcpu} vCPU / ${l.memTotalGiB.toFixed(1)} GiB / ${l.diskTotalGB.toFixed(0)} GB` : '-',
            t ? `\`${t.type}\`` : '-',
            t ? usd(t.hourly, 4) : '-',
            l && l.cpuPct != null ? l.cpuPct.toFixed(1) + '%' : '-',
            l && l.memTotalGiB && l.memUsedGiB != null ? ((l.memUsedGiB / l.memTotalGiB) * 100).toFixed(0) + '%' : '-',
          ];
        }),
      },
    ],
  };
}

function pricingIntent() {
  return {
    title: 'Referensi Harga',
    steps: [`Memuat daftar harga on-demand ${pricing.REGION.code}`],
    blocks: [
      { type: 'p', text: `Biaya dihitung dengan harga AWS on-demand Linux di **${pricing.REGION.name} (${pricing.REGION.code})**. Setiap VPS disetarakan dengan instance EC2 yang vCPU dan RAM-nya paling pas (arsitektur CPU sama).` },
      {
        type: 'ul',
        items: [
          `**EBS gp3 storage:** ${usd(pricing.EBS_GP3_USD_PER_GB_MONTH)}/GB-bulan, dihitung dari total ukuran disk`,
          `**Public IPv4:** ${usd(pricing.PUBLIC_IPV4_USD_PER_HOUR, 3)}/jam per VPS`,
          `**Data Transfer Out:** ${pricing.EGRESS_FREE_GB_PER_MONTH} GB/bulan pertama gratis, selanjutnya ${usd(pricing.EGRESS_USD_PER_GB)}/GB`,
        ],
      },
      {
        type: 'table',
        columns: ['Instance', 'Arch', 'vCPU', 'RAM (GiB)', '$/jam', '$/bulan'],
        rows: pricing.INSTANCE_TYPES.map((i) => [`\`${i.type}\``, i.arch, i.vcpu, i.memGiB, usd(i.hourly, 4), usd(i.hourly * pricing.HOURS_PER_MONTH)]),
      },
    ],
  };
}

function awsBilling(text, opts = {}) {
  const days = opts.days || parseDays(text, 30);
  const r = aws.report(days);
  if (!r) {
    return {
      title: 'Tagihan AWS',
      steps: ['Mengecek sambungan akun AWS'],
      blocks: [{ type: 'p', text: 'Akun AWS belum tersambung atau belum ada data. Buka **Integrations**, tab **Akun AWS**, isi kredensial baca-saja, lalu klik **Sinkronkan sekarang**.' }],
    };
  }
  const blocks = [
    { type: 'p', text: `Tagihan AWS **${days} hari terakhir** adalah **${usd(r.total)} ${r.currency}**, dengan **${usd(r.mtd)}** di bulan ini. Data terbaru bertanggal ${r.lastDate}, karena AWS menunda data sampai 24 jam.` },
  ];
  if (r.services.length) {
    blocks.push({ type: 'table', columns: ['Layanan', 'Biaya', 'Porsi'], rows: r.services.slice(0, 10).map((s) => [s.name, usd(s.amount), r.total ? ((s.amount / r.total) * 100).toFixed(1) + '%' : '0%']) });
  }
  blocks.push({ type: 'p', text: 'Ini tagihan akun AWS yang sebenarnya. Angkanya tidak sama dengan estimasi biaya VPS, dan tidak mengurangi saldo kredit.' });
  return { title: 'Tagihan AWS', steps: [`Membaca data Cost Explorer, ${days} hari`, 'Mengelompokkan per layanan'], blocks };
}

function cloudBilling(text, opts = {}) {
  const days = opts.days || parseDays(text, 30);
  const want = /azure/i.test(text) ? 'azure' : /gcp|google/i.test(text) ? 'gcp' : /aws|amazon/i.test(text) ? 'aws' : null;
  const ov = cloud.overview(Math.max(days, 7));
  const ids = want ? [want] : Object.keys(ov.sources).filter((id) => ov.sources[id].kind === 'billed');
  const picked = ids.map((id) => ov.sources[id]).filter(Boolean);
  const st = cloud.status();
  if (!picked.length) {
    const off = (want ? [want] : ['aws', 'azure', 'gcp']).filter((id) => !st[id].configured).map((id) => st[id].label);
    return {
      title: 'Tagihan cloud',
      steps: ['Mengecek sambungan akun cloud'],
      blocks: [
        { type: 'p', text: want ? `Belum ada data dari **${st[want].label}**.` : 'Belum ada data tagihan dari akun cloud mana pun.' },
        { type: 'p', text: `${off.length ? `Belum tersambung: ${off.join(', ')}. ` : ''}Buka **Integrations**, pilih tab cloud-nya, isi kredensial baca-saja, lalu klik **Sinkronkan sekarang**.` },
      ],
    };
  }
  const total = picked.reduce((a, s) => a + s.total, 0);
  const mtd = picked.reduce((a, s) => a + s.mtd, 0);
  const fc = picked.reduce((a, s) => a + s.forecastMonth, 0);
  const blocks = [
    { type: 'p', text: `Tagihan **${picked.map((s) => s.label).join(', ')}** untuk ${Math.min(days, 30)} hari terakhir adalah **${usd(total)}**. Ini tagihan asli dari akun cloud, bukan estimasi.` },
    { type: 'stats', items: [{ label: 'Bulan ini', value: usd(mtd) }, { label: 'Perkiraan akhir bulan', value: usd(fc) }, { label: 'Sumber', value: String(picked.length) }] },
  ];
  if (picked.length > 1) blocks.push({ type: 'table', columns: ['Cloud', 'Bulan ini', 'Perkiraan akhir bulan', 'Data terbaru'], rows: picked.map((s) => [s.label, usd(s.mtd), usd(s.forecastMonth), s.lastDate]) });
  const svc = {};
  for (const s of picked) for (const x of s.services) svc[`${s.label}: ${x.name}`] = (svc[`${s.label}: ${x.name}`] || 0) + x.amount;
  const slices = Object.entries(svc).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);
  if (slices.length) blocks.push({ type: 'chart', kind: 'donut', title: 'Porsi biaya per layanan', slices });
  blocks.push({ type: 'p', text: `Data tertunda: ${picked.map((s) => `${s.label} sampai ${s.lastDate}`).join(', ')}.` });
  blocks.push({ type: 'follow', items: ['Forecast bulan ini', 'Berapa sisa anggaran saya?'] });
  return { title: 'Tagihan cloud', steps: [`Membaca data ${picked.map((s) => s.label).join(', ')}`, 'Menggabungkan per layanan'], blocks };
}

function planInfo() {
  return {
    title: 'Mode perencanaan',
    steps: ['Mengecek daftar rencana tersimpan'],
    blocks: [
      { type: 'p', text: 'Untuk menghitung biaya **tanpa server asli dan tanpa mengeluarkan uang**, buka halaman **Perencanaan**. Di sana kamu menyusun daftar sumber daya (EC2, EBS, S3, data transfer, NAT Gateway, load balancer) dan langsung melihat perkiraan biaya bulanan, tahunan, dan kumulatif 12 bulan.' },
      { type: 'ul', items: [`Rencana tersimpan: ${(store.db.plans || []).length}`, 'Hasil perencanaan tidak mengubah anggaran, forecast, atau riwayat biaya.'] },
      ...((store.db.plans || []).length ? [{ type: 'table', columns: ['Rencana', 'Per bulan'], rows: (store.db.plans || []).slice(0, 8).map((p) => [p.name, usd(p.monthly)]) }] : []),
      { type: 'follow', items: ['Forecast bulan ini', 'Tampilkan harga'] },
    ],
  };
}

function help() {
  return {
    title: 'FinOps Agent',
    steps: ['Tidak ada intent yang cocok'],
    blocks: [
      { type: 'p', text: 'Saya bisa bantu soal biaya VPS kamu. Coba salah satu ini:' },
      {
        type: 'ul',
        items: [
          '`Cek anomali biaya 7 hari terakhir`',
          '`Tampilkan biaya 30 hari terakhir`',
          '`Forecast bulan ini`',
          '`Rekomendasi rightsizing`',
          '`Berapa saldo kredit saya?`',
          '`Status VPS`',
          '`Tampilkan harga`',
        ],
      },
    ],
  };
}

// Tools the agent (or the AI model) can call. All numbers come from these deterministic functions.
const TOOLS = {
  get_plan_info: { fn: planInfo, needsVps: false, desc: 'Mode perencanaan: hitung biaya tanpa server asli, dan daftar rencana tersimpan', re: /rencana|perencanaan|planning|simulasi biaya|tanpa server|what.?if/i },
  get_cloud_billing: { fn: cloudBilling, needsVps: false, desc: 'Tagihan asli dari akun Azure atau Google Cloud, atau gabungan semua cloud', re: /azure|gcp|google cloud|semua cloud|multi.?cloud|tagihan cloud/i },
  get_aws_billing: { fn: awsBilling, needsVps: false, desc: 'Tagihan akun AWS yang sebenarnya dari Cost Explorer, per layanan', re: /tagihan aws|aws billing|cost explorer|akun aws|biaya aws asli|tagihan asli/i },
  detect_anomalies: { fn: anomalies, needsVps: true, desc: 'Cari anomali/lonjakan biaya dalam N hari terakhir dan event penyebabnya', re: /anomal|spike|lonjak|unusual|aneh/i },
  get_rightsizing: { fn: rightsizingIntent, needsVps: true, desc: 'Rekomendasi rightsizing, VPS idle, potensi penghematan', re: /rightsiz|right-siz|optimi|hemat|saving|save money|idle|downsiz|recommend|rekomendasi/i },
  get_forecast: { fn: forecastIntent, needsVps: true, desc: 'Forecast/proyeksi biaya akhir bulan dan perbandingan dengan budget', re: /forecast|prediksi|perkiraan|proyeksi|projection|end of month|akhir bulan|budget|anggaran/i },
  get_balance: { fn: balanceIntent, needsVps: false, desc: 'Saldo kredit, total terpakai, sisa runway', re: /balance|saldo|credit|kredit|runway/i },
  get_pricing: { fn: pricingIntent, needsVps: false, desc: 'Daftar harga EC2/EBS/IPv4/data transfer AWS us-east-1', re: /pric|harga|tarif|rate card/i },
  get_vps_status: { fn: vpsStatus, needsVps: true, desc: 'Status, spesifikasi, dan instance setara tiap VPS', re: /status|online|offline|list.*(vps|server)|daftar|instance|server/i },
  get_cost_summary: { fn: costSummary, needsVps: true, desc: 'Total biaya N hari terakhir per service dan per VPS', re: /cost|spend|biaya|bill|tagihan|pengeluaran|usage|pemakaian|breakdown/i },
  help: { fn: help, needsVps: false, desc: 'Pertanyaan di luar topik di atas atau sapaan', re: null },
};

function routeRule(text) {
  const t = String(text || '');
  return Object.keys(TOOLS).find((k) => TOOLS[k].re && TOOLS[k].re.test(t)) || 'help';
}

function runTool(name, text, opts = {}) {
  const tool = TOOLS[name] || TOOLS.help;
  if (tool.needsVps && !store.db.vps.length) return noVps();
  return tool.fn(String(text || ''), opts);
}

function respond(text) {
  return runTool(routeRule(text), text);
}

module.exports = { respond, routeRule, runTool, TOOLS, usd, budgetFromContext };
