'use strict';
// Pengecekan FinOps terjadwal. Laporan setiap run disimpan sebagai artifact.
const store = require('./store');
const agent = require('./agent');
const cloud = require('./cloud');
const budget = require('./budget');

const PROMPTS = {
  anomaly: 'Cek lonjakan biaya 1 hari',
  budget: 'Forecast bulan ini',
  rightsizing: 'Cari peluang hemat',
};

// Nama dan deskripsi bawaan versi lama diganti ke teks baru.
const LEGACY = {
  'Daily anomaly check': ['Cek lonjakan harian', 'Cari lonjakan bills 1 hari terakhir dibanding rata-rata 14 hari sebelumnya.'],
  'Cek anomali harian': ['Cek lonjakan harian', 'Cari lonjakan bills 1 hari terakhir dibanding rata-rata 14 hari sebelumnya.'],
  'Monthly budget alert': ['Peringatan budget bulanan', 'Peringatan kalau perkiraan biaya akhir bulan melewati budget.'],
  'Peringatan budget bulanan': ['Peringatan budget bulanan', 'Peringatan kalau perkiraan biaya akhir bulan melewati budget.'],
  'Weekly rightsizing review': ['Review hemat mingguan', 'Cari server stopped yang masih membayar disk dan tipe server setara yang lebih hemat.'],
  'Review rightsizing mingguan': ['Review hemat mingguan', 'Cari server stopped yang masih membayar disk dan tipe server setara yang lebih hemat.'],
};
function migrate() {
  for (const a of store.db.automations) {
    const t = LEGACY[a.name];
    if (t && (a.name !== t[0] || a.description !== t[1])) {
      [a.name, a.description] = t;
      store.save();
    }
  }
}

function evaluate(a) {
  if (a.type === 'anomaly') {
    const found = cloud.detectAnomalies({ fromDays: 1 });
    return { alert: found.length > 0, summary: found.length ? `${found.length} lonjakan, terbesar ${agent.usd(found[0].impact)}` : 'Tidak ada lonjakan' };
  }
  if (a.type === 'budget') {
    const s = budget.status(cloud.overview(30).totals);
    return { alert: s.over, summary: `Perkiraan ${agent.usd(s.forecast)} vs budget ${agent.usd(s.amount)}${s.over ? ' (melebihi budget)' : ''}` };
  }
  if (a.type === 'rightsizing') {
    const total = cloud.savings().reduce((t, s) => t + s.monthly, 0);
    return { alert: total > 0, summary: total > 0 ? `Potensi hemat ${agent.usd(total)}/bulan` : 'Tidak ada potensi hemat' };
  }
  return { alert: false, summary: 'Tipe automation tidak dikenal' };
}

function run(a, trigger = 'schedule') {
  const started = Date.now();
  try {
    const reply = agent.respond(PROMPTS[a.type] || '');
    const result = evaluate(a);
    const artifact = {
      id: store.newId(),
      ts: Date.now(),
      title: `${a.name}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      source: `automation:${a.id}`,
      reply,
    };
    store.db.artifacts.unshift(artifact);
    if (store.db.artifacts.length > 300) store.db.artifacts.length = 300;
    a.lastRun = started;
    a.lastResult = result;
    store.save();
    return { result, artifactId: artifact.id };
  } catch (e) {
    a.lastRun = started;
    a.lastResult = { alert: true, summary: 'Gagal: ' + e.message };
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

module.exports = { run, tick, migrate };
