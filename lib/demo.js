'use strict';
// "VPS sample AWS": a VPS defined only by an EC2 instance type and disk size.
// It has no agent and no usage history. It only contributes a projected (forecast) cost.
const store = require('./store');
const pricing = require('./pricing');

const SAMPLE_OS = 'Amazon Linux 2023';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function projectedMonthly(instanceType, diskGB) {
  const t = pricing.byType(instanceType);
  if (!t) return 0;
  return (t.hourly + pricing.PUBLIC_IPV4_USD_PER_HOUR) * pricing.HOURS_PER_MONTH + diskGB * pricing.EBS_GP3_USD_PER_GB_MONTH;
}

function sampleLast(t, diskGB, ts) {
  return {
    ts,
    hostname: 'aws-sample',
    os: SAMPLE_OS,
    arch: t.arch,
    vcpu: t.vcpu,
    cpuPct: null,
    memTotalGiB: t.memGiB,
    memUsedGiB: null,
    diskTotalGB: diskGB,
    diskUsedGB: null,
    txBytes: 0,
    rxBytes: 0,
    uptimeSec: 0,
  };
}

function create({ name, instanceType, diskGB }) {
  const db = store.db;
  const t = pricing.byType(instanceType);
  if (!t) throw httpError(400, 'Tipe EC2 tidak dikenal');
  const disk = Math.round(Number(diskGB));
  if (!Number.isFinite(disk) || disk < 8 || disk > 16384) throw httpError(400, 'Ukuran disk harus 8–16384 GB');
  if (db.vps.some((v) => v.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'VPS dengan nama itu sudah ada');
  const now = Date.now();
  const vps = {
    id: store.newId(),
    name,
    demo: true, // internal flag: sample VPS without agent
    createdAt: now,
    tokenHash: null,
    instanceType: t.type,
    lastSeen: null,
    last: sampleLast(t, disk, now),
  };
  db.vps.push(vps);
  store.save();
  return vps;
}

// Older versions created a sample VPS with generated history. Drop that history.
function migrate() {
  let changed = false;
  for (const v of store.db.vps) {
    if (!v.demo) continue;
    if (store.db.usage[v.id]) {
      delete store.db.usage[v.id];
      changed = true;
    }
    if (store.db.events) {
      const before = store.db.events.length;
      store.db.events = store.db.events.filter((e) => e.vpsId !== v.id);
      changed ||= before !== store.db.events.length;
    }
    const t = pricing.byType(v.instanceType) || pricing.byType('t3a.small');
    if (!v.last || v.last.cpuPct !== null || v.last.os !== SAMPLE_OS) {
      v.instanceType = t.type;
      v.last = sampleLast(t, v.last?.diskTotalGB || 30, v.createdAt || Date.now());
      if (v.name === 'demo-sim' || v.name === 'sample-vps') v.name = 'aws-sample-1';
      changed = true;
    }
  }
  if (changed) store.save();
}

module.exports = { create, migrate, projectedMonthly };
