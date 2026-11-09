'use strict';
// AWS on-demand Linux prices, region us-east-1 (N. Virginia), one of the cheapest regions.
// Static snapshot of the price list.
// Verify at https://aws.amazon.com/ec2/pricing/on-demand/ before relying on the numbers.

const REGION = { code: 'us-east-1', name: 'US East (N. Virginia)' };
const HOURS_PER_MONTH = 730;
const EBS_GP3_USD_PER_GB_MONTH = 0.08; // EBS gp3 storage
const PUBLIC_IPV4_USD_PER_HOUR = 0.005; // every public IPv4 address, since Feb 2024
const EGRESS_USD_PER_GB = 0.09; // Data Transfer Out to internet, first 10 TB/month tier
const EGRESS_FREE_GB_PER_MONTH = 100; // free DTO per account per month

const INSTANCE_TYPES = [
  // x86_64 (AMD t3a is cheaper than Intel t3)
  { type: 't3a.nano', arch: 'x86_64', vcpu: 2, memGiB: 0.5, hourly: 0.0047 },
  { type: 't3.nano', arch: 'x86_64', vcpu: 2, memGiB: 0.5, hourly: 0.0052 },
  { type: 't3a.micro', arch: 'x86_64', vcpu: 2, memGiB: 1, hourly: 0.0094 },
  { type: 't3.micro', arch: 'x86_64', vcpu: 2, memGiB: 1, hourly: 0.0104 },
  { type: 't3a.small', arch: 'x86_64', vcpu: 2, memGiB: 2, hourly: 0.0188 },
  { type: 't3.small', arch: 'x86_64', vcpu: 2, memGiB: 2, hourly: 0.0208 },
  { type: 't3a.medium', arch: 'x86_64', vcpu: 2, memGiB: 4, hourly: 0.0376 },
  { type: 't3.medium', arch: 'x86_64', vcpu: 2, memGiB: 4, hourly: 0.0416 },
  { type: 't3a.large', arch: 'x86_64', vcpu: 2, memGiB: 8, hourly: 0.0752 },
  { type: 't3.large', arch: 'x86_64', vcpu: 2, memGiB: 8, hourly: 0.0832 },
  { type: 't3a.xlarge', arch: 'x86_64', vcpu: 4, memGiB: 16, hourly: 0.1504 },
  { type: 't3.xlarge', arch: 'x86_64', vcpu: 4, memGiB: 16, hourly: 0.1664 },
  { type: 't3a.2xlarge', arch: 'x86_64', vcpu: 8, memGiB: 32, hourly: 0.3008 },
  { type: 't3.2xlarge', arch: 'x86_64', vcpu: 8, memGiB: 32, hourly: 0.3328 },
  { type: 'm5a.4xlarge', arch: 'x86_64', vcpu: 16, memGiB: 64, hourly: 0.688 },
  { type: 'm5.4xlarge', arch: 'x86_64', vcpu: 16, memGiB: 64, hourly: 0.768 },
  { type: 'm5a.8xlarge', arch: 'x86_64', vcpu: 32, memGiB: 128, hourly: 1.376 },
  { type: 'm5.8xlarge', arch: 'x86_64', vcpu: 32, memGiB: 128, hourly: 1.536 },
  // arm64 (Graviton)
  { type: 't4g.nano', arch: 'arm64', vcpu: 2, memGiB: 0.5, hourly: 0.0042 },
  { type: 't4g.micro', arch: 'arm64', vcpu: 2, memGiB: 1, hourly: 0.0084 },
  { type: 't4g.small', arch: 'arm64', vcpu: 2, memGiB: 2, hourly: 0.0168 },
  { type: 't4g.medium', arch: 'arm64', vcpu: 2, memGiB: 4, hourly: 0.0336 },
  { type: 't4g.large', arch: 'arm64', vcpu: 2, memGiB: 8, hourly: 0.0672 },
  { type: 't4g.xlarge', arch: 'arm64', vcpu: 4, memGiB: 16, hourly: 0.1344 },
  { type: 't4g.2xlarge', arch: 'arm64', vcpu: 8, memGiB: 32, hourly: 0.2688 },
  { type: 'm6g.4xlarge', arch: 'arm64', vcpu: 16, memGiB: 64, hourly: 0.616 },
  { type: 'm6g.8xlarge', arch: 'arm64', vcpu: 32, memGiB: 128, hourly: 1.232 },
].sort((a, b) => a.hourly - b.hourly);

function normArch(arch) {
  return /^(aarch64|arm64)$/i.test(String(arch || '')) ? 'arm64' : 'x86_64';
}

function byType(type) {
  return INSTANCE_TYPES.find((i) => i.type === type) || null;
}

// Cheapest instance with at least the given vCPU and memory for the architecture.
// A VPS reports a bit less RAM than its nominal size, so allow 10% slack by default.
function cheapestFit(vcpu, memGiB, arch = 'x86_64', memSlack = 0.9) {
  const list = INSTANCE_TYPES.filter((i) => i.arch === normArch(arch));
  return list.find((i) => i.vcpu >= vcpu && i.memGiB >= memGiB * memSlack) || list[list.length - 1];
}

module.exports = {
  REGION,
  HOURS_PER_MONTH,
  EBS_GP3_USD_PER_GB_MONTH,
  PUBLIC_IPV4_USD_PER_HOUR,
  EGRESS_USD_PER_GB,
  EGRESS_FREE_GB_PER_MONTH,
  INSTANCE_TYPES,
  normArch,
  byType,
  cheapestFit,
};
