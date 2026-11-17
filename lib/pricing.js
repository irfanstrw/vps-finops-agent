'use strict';
// Harga on-demand Linux untuk server (compute) di tiga platform. Snapshot statis dari halaman harga resmi,
// satu region acuan per platform. Cek ulang sebelum dipakai untuk keputusan:
//   AWS   https://aws.amazon.com/ec2/pricing/on-demand/
//   Azure https://azure.microsoft.com/pricing/details/virtual-machines/linux/
//   GCP   https://cloud.google.com/compute/vm-instance-pricing
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
    instances: [
      ['t3a.nano', 'x86_64', 2, 0.5, 0.0047], ['t3.nano', 'x86_64', 2, 0.5, 0.0052],
      ['t3a.micro', 'x86_64', 2, 1, 0.0094], ['t3.micro', 'x86_64', 2, 1, 0.0104],
      ['t3a.small', 'x86_64', 2, 2, 0.0188], ['t3.small', 'x86_64', 2, 2, 0.0208],
      ['t3a.medium', 'x86_64', 2, 4, 0.0376], ['t3.medium', 'x86_64', 2, 4, 0.0416],
      ['t3a.large', 'x86_64', 2, 8, 0.0752], ['t3.large', 'x86_64', 2, 8, 0.0832],
      ['t3a.xlarge', 'x86_64', 4, 16, 0.1504], ['t3.xlarge', 'x86_64', 4, 16, 0.1664],
      ['t3a.2xlarge', 'x86_64', 8, 32, 0.3008], ['t3.2xlarge', 'x86_64', 8, 32, 0.3328],
      ['m5.large', 'x86_64', 2, 8, 0.096], ['m5.xlarge', 'x86_64', 4, 16, 0.192], ['m5.2xlarge', 'x86_64', 8, 32, 0.384],
      ['c5.large', 'x86_64', 2, 4, 0.085], ['c5.xlarge', 'x86_64', 4, 8, 0.17],
      ['r5.large', 'x86_64', 2, 16, 0.126], ['r5.xlarge', 'x86_64', 4, 32, 0.252],
      ['m5.4xlarge', 'x86_64', 16, 64, 0.768], ['m5a.4xlarge', 'x86_64', 16, 64, 0.688],
      ['t4g.nano', 'arm64', 2, 0.5, 0.0042], ['t4g.micro', 'arm64', 2, 1, 0.0084], ['t4g.small', 'arm64', 2, 2, 0.0168],
      ['t4g.medium', 'arm64', 2, 4, 0.0336], ['t4g.large', 'arm64', 2, 8, 0.0672], ['t4g.xlarge', 'arm64', 4, 16, 0.1344],
      ['t4g.2xlarge', 'arm64', 8, 32, 0.2688], ['m6g.large', 'arm64', 2, 8, 0.077], ['m6g.xlarge', 'arm64', 4, 16, 0.154],
    ],
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
    instances: [
      ['Standard_B1s', 'x86_64', 1, 1, 0.0104], ['Standard_B1ms', 'x86_64', 1, 2, 0.0207],
      ['Standard_B2s', 'x86_64', 2, 4, 0.0416], ['Standard_B2ms', 'x86_64', 2, 8, 0.0832],
      ['Standard_B4ms', 'x86_64', 4, 16, 0.166], ['Standard_B8ms', 'x86_64', 8, 32, 0.333],
      ['Standard_D2s_v5', 'x86_64', 2, 8, 0.096], ['Standard_D4s_v5', 'x86_64', 4, 16, 0.192], ['Standard_D8s_v5', 'x86_64', 8, 32, 0.384],
      ['Standard_D2as_v5', 'x86_64', 2, 8, 0.086], ['Standard_D4as_v5', 'x86_64', 4, 16, 0.172], ['Standard_D8as_v5', 'x86_64', 8, 32, 0.344],
      ['Standard_F2s_v2', 'x86_64', 2, 4, 0.0846], ['Standard_F4s_v2', 'x86_64', 4, 8, 0.169],
      ['Standard_E2s_v5', 'x86_64', 2, 16, 0.126], ['Standard_E4s_v5', 'x86_64', 4, 32, 0.252],
      ['Standard_D16s_v5', 'x86_64', 16, 64, 0.768],
      ['Standard_D2ps_v5', 'arm64', 2, 8, 0.077], ['Standard_D4ps_v5', 'arm64', 4, 16, 0.154], ['Standard_D8ps_v5', 'arm64', 8, 32, 0.308],
    ],
  },
  gcp: {
    label: 'Google Cloud',
    product: 'Compute Engine',
    region: { code: 'us-central1', name: 'Iowa (us-central1)' },
    diskPerGBMonth: 0.1, // Balanced persistent disk
    diskLabel: 'Balanced PD',
    ipv4Hourly: 0.005, // external IPv4 yang dipakai VM
    lbHourly: 0.025, // forwarding rule pertama
    egressPerGB: 0.12, egressFreeGB: 0, // Premium Tier, ke sebagian besar tujuan
    instances: [
      ['e2-micro', 'x86_64', 2, 1, 0.00838], ['e2-small', 'x86_64', 2, 2, 0.01675], ['e2-medium', 'x86_64', 2, 4, 0.03351],
      ['e2-standard-2', 'x86_64', 2, 8, 0.06701], ['e2-standard-4', 'x86_64', 4, 16, 0.13402], ['e2-standard-8', 'x86_64', 8, 32, 0.26805],
      ['e2-highmem-2', 'x86_64', 2, 16, 0.09039], ['e2-highcpu-4', 'x86_64', 4, 4, 0.09892],
      ['n2-standard-2', 'x86_64', 2, 8, 0.09712], ['n2-standard-4', 'x86_64', 4, 16, 0.19424], ['n2-standard-8', 'x86_64', 8, 32, 0.38847],
      ['n2d-standard-2', 'x86_64', 2, 8, 0.08449], ['n2d-standard-4', 'x86_64', 4, 16, 0.16898],
      ['c3-standard-4', 'x86_64', 4, 16, 0.20161], ['n2-standard-16', 'x86_64', 16, 64, 0.77695],
      ['t2a-standard-1', 'arm64', 1, 4, 0.0385], ['t2a-standard-2', 'arm64', 2, 8, 0.077], ['t2a-standard-4', 'arm64', 4, 16, 0.154],
    ],
  },
};

for (const p of Object.values(PROVIDERS)) {
  p.instances = p.instances.map(([type, arch, vcpu, memGiB, hourly]) => ({ type, arch, vcpu, memGiB, hourly })).sort((a, b) => a.hourly - b.hourly);
}

function byType(provider, type) {
  const p = PROVIDERS[provider];
  if (!p || !type) return null;
  const t = String(type).toLowerCase();
  return p.instances.find((i) => i.type.toLowerCase() === t) || null;
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
