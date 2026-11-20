'use strict';
// Harga on-demand Linux untuk server (compute) di tiga platform, semuanya region US East
// (AWS us-east-1, Azure eastus, Google Cloud us-east1). Daftar tipe ada di lib/instances.json,
// dibuat dari daftar harga resmi:
//   AWS   https://aws.amazon.com/ec2/pricing/on-demand/ (general purpose, compute, memory, storage optimized; tanpa metal dan GPU)
//   Azure https://prices.azure.com/api/retail/prices (Linux pay-as-you-go; tanpa GPU, HPC, confidential, dan seri lama)
//   GCP   https://cloud.google.com/products/compute/pricing/general-purpose
// Format tiap baris: [tipe, arsitektur, vCPU, RAM GiB, harga per jam USD].
const CATALOG = require('./instances.json');
const HOURS_PER_MONTH = 730;

const PROVIDERS = {
  aws: {
    label: 'AWS',
    product: 'Amazon EC2',
    region: { code: 'us-east-1', name: 'US East (N. Virginia)' },
    diskPerGBMonth: 0.08, // EBS gp3
    diskLabel: 'EBS gp3',
    ipv4Hourly: 0.005, // public IPv4
    lbHourly: 0.0225, // Application Load Balancer, tanpa LCU
    egressPerGB: 0.09, egressFreeGB: 100, // data transfer keluar ke internet
    instances: CATALOG.aws,
  },
  azure: {
    label: 'Azure',
    product: 'Azure Virtual Machines',
    region: { code: 'eastus', name: 'East US' },
    diskPerGBMonth: 0.075, // Standard SSD, rata-rata per GB
    diskLabel: 'Standard SSD',
    ipv4Hourly: 0.005, // Standard static public IP
    lbHourly: 0.025, // Standard Load Balancer, 5 rule pertama
    egressPerGB: 0.087, egressFreeGB: 100,
    instances: CATALOG.azure,
  },
  gcp: {
    label: 'Google Cloud',
    product: 'Compute Engine',
    region: { code: 'us-east1', name: 'US East (South Carolina)' },
    diskPerGBMonth: 0.1, // Balanced persistent disk
    diskLabel: 'Balanced PD',
    ipv4Hourly: 0.005, // external IPv4 yang dipakai VM
    lbHourly: 0.025, // forwarding rule pertama
    egressPerGB: 0.12, egressFreeGB: 0, // Premium Tier, ke sebagian besar tujuan
    instances: CATALOG.gcp,
  },
};

// Family umum untuk web, aplikasi, dan database kecil sampai menengah. Dipakai Rekomendasi, saran hemat,
// dan tabel harga di chat supaya pilihan tidak jatuh ke tipe khusus (storage optimized, memory sangat besar,
// burstable lama, dan sejenisnya). Custom tetap bisa memakai semua tipe di katalog.
const COMMON = {
  aws: /^(t3|t3a|t4g|m5|m5a|m6i|m6a|m6g|m7i|m7a|m7g|m8g|c5|c6i|c6a|c6g|c7i|c7a|c7g|c8g|r5|r6i|r6a|r6g|r7i|r7a|r7g|r8g)\./,
  azure: /^Standard_(B\d+(s|ms|ls)|B\d+(s|as|ps)_v2|D\d+(s|as|ps|ls|als|pls)_v[56]|E\d+(s|as|ps)_v[56]|F\d+s_v2|F\d+as_v6)$/,
  gcp: /^(e2|n2|n2d|n4|n4d|n4a|c3|c3d|c4|c4a|c4d|t2d|t2a)-/,
};

const INDEX = {};
for (const [id, p] of Object.entries(PROVIDERS)) {
  p.instances = p.instances
    .map(([type, arch, vcpu, memGiB, hourly]) => ({ type, arch, vcpu, memGiB, hourly, common: COMMON[id].test(type) && vcpu <= 64 }))
    .sort((a, b) => a.hourly - b.hourly);
  INDEX[id] = new Map(p.instances.map((i) => [i.type.toLowerCase(), i]));
}

function byType(provider, type) {
  if (!INDEX[provider] || !type) return null;
  return INDEX[provider].get(String(type).toLowerCase()) || null;
}

// Biaya satu server per bulan: compute + disk + satu IPv4 publik.
function serverMonthly(provider, type, diskGB = 0, withIp = true) {
  const p = PROVIDERS[provider];
  const t = byType(provider, type);
  if (!p || !t) return null;
  const compute = t.hourly * HOURS_PER_MONTH;
  const disk = Math.max(0, Number(diskGB) || 0) * p.diskPerGBMonth;
  const ip = withIp ? p.ipv4Hourly * HOURS_PER_MONTH : 0;
  return { compute, disk, ip, total: compute + disk + ip };
}

module.exports = { HOURS_PER_MONTH, PROVIDERS, byType, serverMonthly };
