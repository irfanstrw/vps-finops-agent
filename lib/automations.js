'use strict';
// Scheduled FinOps checks. Each run is recorded as a task and its report saved as an artifact.
const store = require('./store');
const costs = require('./costs');
const agent = require('./agent');

const PROMPTS = {
  anomaly: 'Cek anomali biaya 1 hari terakhir',
  budget: 'Forecast bulan ini dibanding budget',
  rightsizing: 'Rekomendasi rightsizing',
};

// Translate default automations created by older versions (English names).
const LEGACY = {
  'Daily anomaly check': ['Cek anomali harian', 'Cari lonjakan biaya 1 hari terakhir dibanding baseline 14 hari sebelumnya.'],
  'Monthly budget alert': ['Peringatan budget bulanan', 'Peringatan jika forecast biaya bulan ini melewati budget.'],
  'Weekly rightsizing review': ['Review rightsizing mingguan', 'Cari VPS yang kebesaran atau idle dan hitung potensi penghematan.'],
};
function migrate() {
  for (const a of store.db.automations) {
    const t = LEGACY[a.name];
    if (t) {
      [a.name, a.description] = t;
      store.save();
    }
  }
}

function evaluate(a) {
  if (a.type === 'anomaly') {
    const found = costs.detectAnomalies({ fromDays: 1 });
    return { alert: found.length > 0, summary: found.length ? `${found.length} anomali ditemukan, dampak terbesar ${agent.usd(found[0].impact)}` : 'Tidak ada anomali' };
  }
  if (a.type === 'budget') {
    const f = costs.forecast();
    const budget = Number(a.params.monthlyBudgetUsd) || 0;
    const over = budget > 0 && f.forecast > budget;
    return { alert: over, summary: `Forecast ${agent.usd(f.forecast)} vs budget ${agent.usd(budget)}${over ? ' (melebihi budget)' : ''}` };
  }
  if (a.type === 'rightsizing') {
    const recs = store.db.vps.map(costs.rightsize).filter((r) => r && r.enoughData);
    const total = recs.reduce((s, r) => s + r.monthlySavings, 0);
    return { alert: total > 0, summary: total > 0 ? `Potensi hemat ${agent.usd(total)}/bulan` : 'Tidak ada potensi hemat' };
  }
  return { alert: false, summary: 'Tipe automation tidak dikenal' };
}

function addTask(t) {
  const db = store.db;
  db.tasks ||= [];
  const task = { id: store.newId(), ts: Date.now(), ...t };
  db.tasks.unshift(task);
  if (db.tasks.length > 500) db.tasks.length = 500;
  return task;
}

function run(a, trigger = 'schedule') {
  const started = Date.now();
  try {
    const reply = agent.respond(PROMPTS[a.type] || '');
    const result = evaluate(a);
    const artifact = {
      id: store.newId(),
      ts: Date.now(),
      title: `${a.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      source: `automation:${a.id}`,
      reply,
    };
    store.db.artifacts.unshift(artifact);
    if (store.db.artifacts.length > 300) store.db.artifacts.length = 300;
    a.lastRun = started;
    a.lastResult = result;
    addTask({ name: a.name, kind: 'automation', trigger, status: result.alert ? 'alert' : 'ok', summary: result.summary, artifactId: artifact.id, durationMs: Date.now() - started });
    store.save();
    return { result, artifactId: artifact.id };
  } catch (e) {
    a.lastRun = started;
    a.lastResult = { alert: true, summary: 'Gagal: ' + e.message };
    addTask({ name: a.name, kind: 'automation', trigger, status: 'failed', summary: e.message, durationMs: Date.now() - started });
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
      console.error(`Automation "${a.name}" failed:`, e);
    }
  }
}

module.exports = { run, tick, migrate, addTask };
