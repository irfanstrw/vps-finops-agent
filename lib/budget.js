'use strict';
// Budget bulanan: uang yang disediakan pengguna (pribadi atau usaha) untuk biaya server per bulan.
// Diatur manual: tambah, kurangi, atau tetapkan. Bukan saldo akun cloud mana pun.
const store = require('./store');

function settings() {
  const s = store.db.settings;
  if (typeof s.monthlyBudgetUsd !== 'number') {
    // Versi lama menyimpan kredit awal + daftar top-up. Pakai totalnya sebagai budget bulanan.
    const legacy = (s.startingCreditUsd || 0) + (s.topups || []).reduce((a, t) => a + t.amount, 0);
    s.monthlyBudgetUsd = legacy > 0 ? Math.round(legacy * 100) / 100 : 50;
    delete s.startingCreditUsd;
    delete s.topups;
    store.save();
  }
  s.budgetLog ||= [];
  return s;
}

function get() {
  return settings().monthlyBudgetUsd;
}

const LIM = 10000000;
function change(mode, amount) {
  const n = Number(amount);
  const s = settings();
  if (mode === 'set') {
    if (!Number.isFinite(n) || n < 0 || n > LIM) throw Object.assign(new Error(`Budget harus antara 0 dan ${LIM}`), { status: 400 });
    s.monthlyBudgetUsd = n;
  } else {
    if (!Number.isFinite(n) || n <= 0 || n > LIM) throw Object.assign(new Error('Jumlah harus lebih dari 0'), { status: 400 });
    s.monthlyBudgetUsd = Math.max(0, s.monthlyBudgetUsd + (mode === 'subtract' ? -n : n));
  }
  s.monthlyBudgetUsd = Math.round(s.monthlyBudgetUsd * 100) / 100;
  s.budgetLog.unshift({ ts: Date.now(), mode, amount: n, result: s.monthlyBudgetUsd });
  if (s.budgetLog.length > 50) s.budgetLog.length = 50;
  store.save();
  return s.monthlyBudgetUsd;
}

// Status budget bulan ini terhadap biaya bulan berjalan dan perkiraan akhir bulan.
function status(totals) {
  const amount = get();
  return {
    amount,
    used: totals.mtd,
    remaining: amount - totals.mtd,
    forecast: totals.forecast,
    pctForecast: amount > 0 ? (totals.forecast / amount) * 100 : 0,
    over: amount > 0 && totals.forecast > amount,
  };
}

module.exports = { get, change, status, log: () => settings().budgetLog };
