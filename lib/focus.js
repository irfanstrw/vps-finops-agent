'use strict';
// Ekspor tagihan dengan nama kolom FOCUS (FinOps Open Cost and Usage Specification), supaya data dari
// AWS, Azure, dan Google Cloud berbentuk sama. Ini subset kolom FOCUS, bukan ekspor tersertifikasi.
// Kolom tambahan diawali "x_". Hanya tagihan asli yang diekspor, bukan estimasi.
const cloud = require('./cloud');

const COLUMNS = [
  'ProviderName', 'InvoiceIssuerName', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ServiceName', 'BilledCost', 'EffectiveCost', 'x_Source',
];

const PROVIDERS = {
  aws: { name: 'AWS', issuer: 'Amazon Web Services' },
  azure: { name: 'Microsoft', issuer: 'Microsoft' },
  gcp: { name: 'Google Cloud', issuer: 'Google Cloud' },
};

const nextDay = (date) => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

function rows() {
  const out = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const days = cloud.computeDays(id);
    const currency = require('./' + id).currency();
    for (const [date, services] of Object.entries(days)) {
      for (const [name, amount] of Object.entries(services)) {
        out.push({
          ProviderName: p.name, InvoiceIssuerName: p.issuer, BillingCurrency: currency,
          ChargePeriodStart: date, ChargePeriodEnd: nextDay(date), ChargeCategory: 'Usage', ServiceName: name,
          BilledCost: amount.toFixed(6), EffectiveCost: amount.toFixed(6), x_Source: `${id}-billing-api`,
        });
      }
    }
  }
  return out.sort((a, b) => a.ChargePeriodStart.localeCompare(b.ChargePeriodStart) || a.ProviderName.localeCompare(b.ProviderName));
}

const cell = (v) => {
  const s = String(v ?? '');
  // Cegah rumus spreadsheet dari nama yang diawali karakter khusus.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv() {
  return [COLUMNS.join(','), ...rows().map((row) => COLUMNS.map((c) => cell(row[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { COLUMNS, rows, toCsv };
