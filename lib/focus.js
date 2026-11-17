'use strict';
// Ekspor biaya dengan nama kolom FOCUS (FinOps Open Cost and Usage Specification), supaya data dari
// sumber mana pun (agent VPS, AWS) berbentuk sama. Ini subset kolom FOCUS, bukan ekspor yang tersertifikasi.
// Kolom tambahan diawali "x_". VPS sample AWS tidak diekspor karena hanya proyeksi, bukan biaya terjadi.
const store = require('./store');
const costs = require('./costs');
const aws = require('./aws');

const COLUMNS = [
  'ProviderName', 'InvoiceIssuerName', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ServiceName', 'ResourceId', 'ResourceName', 'RegionId', 'BilledCost', 'EffectiveCost', 'x_Source', 'x_PriceReference',
];

function nextDay(date) {
  return new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}

function rows() {
  const out = [];
  for (const v of store.db.vps) {
    if (v.demo) continue;
    for (const [date, b] of Object.entries(store.db.usage[v.id] || {})) {
      for (const [key, name] of Object.entries(costs.SERVICES)) {
        const cost = b.cost[key];
        if (!cost) continue;
        out.push({
          ProviderName: 'Self-hosted VPS',
          InvoiceIssuerName: 'FinOps Agent (estimasi)',
          BillingCurrency: 'USD',
          ChargePeriodStart: date,
          ChargePeriodEnd: nextDay(date),
          ChargeCategory: 'Usage',
          ServiceName: name,
          ResourceId: v.id,
          ResourceName: v.name,
          RegionId: 'us-east-1',
          BilledCost: cost.toFixed(6),
          EffectiveCost: cost.toFixed(6),
          x_Source: 'vps-agent-estimate',
          x_PriceReference: 'aws-us-east-1-on-demand',
        });
      }
    }
  }
  const r = aws.report(3650);
  if (r) {
    for (const [date, services] of Object.entries(r.raw)) {
      for (const [name, amount] of Object.entries(services)) {
        out.push({
          ProviderName: 'AWS',
          InvoiceIssuerName: 'Amazon Web Services',
          BillingCurrency: r.currency,
          ChargePeriodStart: date,
          ChargePeriodEnd: nextDay(date),
          ChargeCategory: 'Usage',
          ServiceName: name,
          ResourceId: '',
          ResourceName: '',
          RegionId: '',
          BilledCost: amount.toFixed(6),
          EffectiveCost: amount.toFixed(6),
          x_Source: 'aws-cost-explorer',
          x_PriceReference: '',
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
  const r = rows();
  return [COLUMNS.join(','), ...r.map((row) => COLUMNS.map((c) => cell(row[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { COLUMNS, rows, toCsv };
