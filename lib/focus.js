'use strict';
// Ekspor biaya dengan nama kolom FOCUS (FinOps Open Cost and Usage Specification), supaya data dari
// sumber mana pun (agent VPS, AWS, Azure, Google Cloud) berbentuk sama. Ini subset kolom FOCUS, bukan ekspor yang tersertifikasi.
// Kolom tambahan diawali "x_". VPS sample AWS tidak diekspor karena hanya proyeksi, bukan biaya terjadi.
const store = require('./store');
const costs = require('./costs');
const cloud = require('./cloud');

const COLUMNS = [
  'ProviderName', 'InvoiceIssuerName', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ServiceName', 'ResourceId', 'ResourceName', 'RegionId', 'BilledCost', 'EffectiveCost', 'x_Source', 'x_PriceReference',
];

const PROVIDERS = {
  aws: { name: 'AWS', issuer: 'Amazon Web Services' },
  azure: { name: 'Microsoft', issuer: 'Microsoft' },
  gcp: { name: 'Google Cloud', issuer: 'Google Cloud' },
};

const nextDay = (date) => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

function rows() {
  const out = [];
  // VPS: dipisah per VPS supaya ResourceId terisi.
  for (const v of store.db.vps) {
    if (v.demo) continue;
    for (const [date, b] of Object.entries(store.db.usage[v.id] || {})) {
      for (const [key, name] of Object.entries(costs.SERVICES)) {
        const cost = b.cost[key];
        if (!cost) continue;
        out.push({
          ProviderName: 'Self-hosted VPS', InvoiceIssuerName: 'FinOps Agent (estimasi)', BillingCurrency: 'USD',
          ChargePeriodStart: date, ChargePeriodEnd: nextDay(date), ChargeCategory: 'Usage', ServiceName: name,
          ResourceId: v.id, ResourceName: v.name, RegionId: 'us-east-1', BilledCost: cost.toFixed(6), EffectiveCost: cost.toFixed(6),
          x_Source: 'vps-agent-estimate', x_PriceReference: 'aws-us-east-1-on-demand',
        });
      }
    }
  }
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const days = cloud.daysFor(id);
    const currency = require('./' + id).currency();
    for (const [date, services] of Object.entries(days)) {
      for (const [name, amount] of Object.entries(services)) {
        out.push({
          ProviderName: p.name, InvoiceIssuerName: p.issuer, BillingCurrency: currency,
          ChargePeriodStart: date, ChargePeriodEnd: nextDay(date), ChargeCategory: 'Usage', ServiceName: name,
          ResourceId: '', ResourceName: '', RegionId: '', BilledCost: amount.toFixed(6), EffectiveCost: amount.toFixed(6),
          x_Source: `${id}-billing-api`, x_PriceReference: '',
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
