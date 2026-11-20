'use strict';
// Pengecekan FinOps terjadwal. Semua angka dihitung dari data server dan bills yang sudah disinkron,
// bukan dari model AI. Laporan setiap run disimpan sebagai artifact.
const store = require('./store');
const agent = require('./agent');
const cloud = require('./cloud');
const budget = require('./budget');
const usd = agent.usd;

const CATEGORY = { cost: 'Biaya', server: 'Server', sync: 'Integrasi' };
const PCTS = [50, 80, 90];

// Definisi tiap tipe. `prompt` berarti laporan artifact memakai jawaban agent untuk pertanyaan itu;
// tanpa prompt, laporan dibuat dari `details` hasil pengecekan.
const DEFS = {
  anomaly: {
    name: 'Cek lonjakan harian', category: 'cost', intervalHours: 24, enabled: true,
    description: 'Cari lonjakan bills 1 hari terakhir dibanding rata-rata 14 hari sebelumnya.',
    prompt: 'Cek lonjakan biaya 1 hari',
    evaluate() {
      const found = cloud.detectAnomalies({ fromDays: 1 });
      return { level: found.length ? 'alert' : 'ok', summary: found.length ? `${found.length} lonjakan, terbesar ${usd(found[0].impact)}` : 'Tidak ada lonjakan' };
    },
  },
  budget: {
    name: 'Peringatan budget bulanan', category: 'cost', intervalHours: 24, enabled: true,
    description: 'Peringatan kalau perkiraan biaya akhir bulan melewati budget.',
    prompt: 'Forecast bulan ini',
    evaluate() {
      const s = budget.status(cloud.overview(30).totals);
      return { level: s.over ? 'alert' : 'ok', summary: `Perkiraan ${usd(s.forecast)} dari budget ${usd(s.amount)}${s.over ? ', melebihi budget' : ''}` };
    },
  },
  budget_threshold: {
    name: 'Batas awal budget', category: 'cost', intervalHours: 24, enabled: true,
    description: 'Peringatan lebih awal saat perkiraan akhir bulan sudah mencapai persentase tertentu dari budget.',
    params: { pct: 80 },
    evaluate(a) {
      const pct = PCTS.includes(a.params?.pct) ? a.params.pct : 80;
      const s = budget.status(cloud.overview(30).totals);
      if (!(s.amount > 0)) return { level: 'warn', summary: 'Budget bulanan belum diatur' };
      const hit = s.pctForecast >= pct;
      return {
        level: hit ? (s.over ? 'alert' : 'warn') : 'ok',
        summary: `Perkiraan ${s.pctForecast.toFixed(0)}% dari budget, batas ${pct}%`,
        details: [`Budget ${usd(s.amount)}, terpakai ${usd(s.used)}, perkiraan akhir bulan ${usd(s.forecast)}.`, hit ? `Perkiraan sudah melewati ${pct}% budget.` : `Masih di bawah ${pct}% budget.`],
      };
    },
  },
  daily_summary: {
    name: 'Ringkasan biaya harian', category: 'cost', intervalHours: 24, enabled: false,
    description: 'Biaya server kemarin dibanding rata-rata 7 hari sebelumnya, per platform.',
    evaluate() {
      const o = cloud.overview(15);
      if (!o.hasData) return { level: 'warn', summary: 'Belum ada data biaya' };
      const s = o.series;
      const y = s[s.length - 2];
      const prev = s.slice(-9, -2);
      const avg = prev.reduce((t, r) => t + r.total, 0) / (prev.length || 1);
      const diff = avg > 0 ? Math.round(((y.total - avg) / avg) * 100) || 0 : 0;
      const per = cloud.IDS.filter((id) => (y[id] || 0) > 0).map((id) => `${cloud.LABEL[id]}: ${usd(y[id])}`);
      return {
        level: 'ok',
        summary: `Kemarin ${usd(y.total)}, rata-rata 7 hari ${usd(avg)}${avg > 0 ? ` (${diff > 0 ? '+' : ''}${diff}%)` : ''}`,
        details: [`Tanggal ${y.date}.`, ...(per.length ? per : ['Tidak ada biaya tercatat.']), `Biaya bulan berjalan ${usd(o.totals.mtd)}.`],
      };
    },
  },
  rightsizing: {
    name: 'Review hemat mingguan', category: 'server', intervalHours: 168, enabled: false,
    description: 'Cari server stopped yang masih membayar disk dan tipe server setara yang lebih hemat.',
    prompt: 'Cari peluang hemat',
    evaluate() {
      const total = cloud.savings().reduce((t, s) => t + s.monthly, 0);
      return { level: total > 0 ? 'warn' : 'ok', summary: total > 0 ? `Potensi hemat ${usd(total)} per bulan` : 'Tidak ada potensi hemat' };
    },
  },
  stopped_disk: {
    name: 'Server stopped yang masih membayar disk', category: 'server', intervalHours: 24, enabled: true,
    description: 'Daftar server stopped beserta biaya disk per bulan yang tetap berjalan.',
    evaluate() {
      const list = cloud.servers().filter((s) => s.state === 'stopped' && s.parts.disk > 0);
      const total = list.reduce((t, s) => t + s.parts.disk, 0);
      return {
        level: list.length ? 'warn' : 'ok',
        summary: list.length ? `${list.length} server stopped, disk ${usd(total)} per bulan` : 'Tidak ada server stopped dengan disk berbayar',
        details: list.map((s) => `${s.name} (${cloud.LABEL[s.provider]}, ${s.type}): disk ${s.diskGB} GB, ${usd(s.parts.disk)} per bulan`),
      };
    },
  },
  new_server: {
    name: 'Server baru terdeteksi', category: 'server', intervalHours: 6, enabled: true,
    description: 'Catat server yang muncul sejak pengecekan sebelumnya beserta perkiraan biayanya.',
    evaluate(a) {
      const list = cloud.servers();
      const key = (s) => `${s.provider}:${s.id}`;
      const seen = Array.isArray(a.state?.seen) ? new Set(a.state.seen) : null;
      a.state = { seen: list.map(key).slice(0, 500) };
      if (!seen) return { level: 'ok', summary: `${list.length} server dicatat sebagai acuan awal` };
      const fresh = list.filter((s) => !seen.has(key(s)));
      const total = fresh.reduce((t, s) => t + s.monthly, 0);
      return {
        level: fresh.length ? 'warn' : 'ok',
        summary: fresh.length ? `${fresh.length} server baru, perkiraan ${usd(total)} per bulan` : 'Tidak ada server baru',
        details: fresh.map((s) => `${s.name} (${cloud.LABEL[s.provider]}, ${s.type}, ${s.state}): ${usd(s.monthly)} per bulan`),
      };
    },
  },
  sync_health: {
    name: 'Kesehatan sinkron cloud', category: 'sync', intervalHours: 6, enabled: true,
    description: 'Cek error sinkron dan data yang lebih dari 48 jam belum diperbarui di setiap platform yang terhubung.',
    evaluate() {
      const st = Object.values(cloud.status()).filter((s) => s.configured);
      if (!st.length) return { level: 'warn', summary: 'Belum ada platform yang terhubung' };
      const issues = [];
      for (const s of st) {
        const err = s.lastError || s.serversError || s.billingError;
        if (err) issues.push(`${s.label}: ${err}`);
        else if (!s.lastSync) issues.push(`${s.label}: belum pernah berhasil sinkron`);
        else if (Date.now() - s.lastSync > 48 * 3600000) issues.push(`${s.label}: sinkron terakhir ${Math.floor((Date.now() - s.lastSync) / 3600000)} jam lalu`);
      }
      return {
        level: issues.length ? 'alert' : 'ok',
        summary: issues.length ? `${issues.length} dari ${st.length} platform bermasalah` : `${st.length} platform tersinkron normal`,
        details: issues.length ? issues : st.map((s) => `${s.label}: sinkron terakhir ${new Date(s.lastSync).toISOString().slice(0, 16).replace('T', ' ')} UTC`),
      };
    },
  },
};

const REMOVED = ['unknown_type'];

// Nama dan deskripsi bawaan versi lama diganti ke teks baru.
const LEGACY = {
  'Daily anomaly check': 'anomaly',
  'Cek anomali harian': 'anomaly',
  'Monthly budget alert': 'budget',
  'Weekly rightsizing review': 'rightsizing',
  'Review rightsizing mingguan': 'rightsizing',
};

function fresh(type) {
  const d = DEFS[type];
  return { id: store.newId(), name: d.name, type, description: d.description, enabled: d.enabled, intervalHours: d.intervalHours, params: { ...(d.params || {}) }, lastRun: null, lastResult: null };
}

// Tipe baru ditambahkan ke daftar yang sudah ada. Pengaturan pengguna (aktif, interval, params) tidak ditimpa.
function migrate() {
  store.db.automations ||= [];
  let changed = false;
  // Tipe yang sudah dihapus dibuang dari data tersimpan.
  const before = store.db.automations.length;
  store.db.automations = store.db.automations.filter((a) => !REMOVED.includes(a.type));
  if (store.db.automations.length !== before) changed = true;
  const list = store.db.automations;
  for (const a of list) {
    // Nama dan deskripsi tidak bisa diubah pengguna, jadi selalu disamakan dengan definisi terbaru.
    const d = DEFS[a.type] || DEFS[LEGACY[a.name]];
    if (d && (a.name !== d.name || a.description !== d.description)) { a.name = d.name; a.description = d.description; changed = true; }
    if (DEFS[a.type]?.params && !a.params?.pct) { a.params = { ...DEFS[a.type].params, ...(a.params || {}) }; changed = true; }
  }
  for (const type of Object.keys(DEFS)) {
    if (!list.some((a) => a.type === type)) { list.push(fresh(type)); changed = true; }
  }
  if (changed) store.save();
}

function evaluate(a) {
  const d = DEFS[a.type];
  if (!d) return { level: 'warn', alert: false, summary: 'Tipe automation tidak dikenal' };
  const r = d.evaluate(a);
  return { ...r, alert: r.level === 'alert' };
}

function report(a, r) {
  const d = DEFS[a.type];
  if (d?.prompt) return agent.respond(d.prompt);
  return {
    title: a.name,
    steps: [`Pengecekan ${a.name.toLowerCase()}`],
    blocks: [{ type: 'p', text: `**${r.summary}.**` }, ...(r.details?.length ? [{ type: 'ul', items: r.details }] : [])],
  };
}

function run(a, trigger = 'schedule') {
  const started = Date.now();
  try {
    const result = evaluate(a);
    const artifact = {
      id: store.newId(),
      ts: Date.now(),
      title: `${a.name}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      source: `automation:${a.id}`,
      reply: report(a, result),
    };
    delete result.details;
    store.db.artifacts.unshift(artifact);
    if (store.db.artifacts.length > 300) store.db.artifacts.length = 300;
    a.lastRun = started;
    a.lastResult = { ...result, trigger };
    a.lastArtifact = artifact.id;
    store.save();
    return { result, artifactId: artifact.id };
  } catch (e) {
    a.lastRun = started;
    a.lastResult = { level: 'alert', alert: true, summary: 'Gagal: ' + e.message, trigger };
    store.save();
    throw e;
  }
}

function tick() {
  const now = Date.now();
  for (const a of store.db.automations) {
    if (!a.enabled) continue;
    if (a.lastRun && now - a.lastRun < a.intervalHours * 3600000) continue;
    try {
      run(a);
    } catch (e) {
      console.error(`Automation "${a.name}" gagal:`, e);
    }
  }
}

// Data untuk halaman Automations: daftar tersimpan ditambah kategori dan pilihan params.
function list() {
  return store.db.automations.map((a) => ({ ...a, state: undefined, category: DEFS[a.type]?.category || 'cost', categoryLabel: CATEGORY[DEFS[a.type]?.category] || 'Biaya', pcts: a.type === 'budget_threshold' ? PCTS : undefined }));
}

module.exports = { run, tick, migrate, list, DEFS, PCTS, CATEGORY };
