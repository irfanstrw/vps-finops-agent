'use strict';
// Turns VPS heartbeats into AWS-priced charges (us-east-1 on-demand), deducted from the credit balance.
const store = require('./store');
const pricing = require('./pricing');

const SERVICES = {
  compute: 'Amazon EC2 (compute)',
  storage: 'Amazon EBS (gp3)',
  ipv4: 'Public IPv4 address',
  egress: 'Data Transfer Out',
};
const MAX_GAP_SEC = 300; // a longer gap between heartbeats means the agent/VPS was down: don't bill it

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function monthKey(ts) {
  return new Date(ts).toISOString().slice(0, 7);
}
function round(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function emptyBucket() {
  return {
    seconds: 0,
    cpuPctSec: 0,
    memPctSec: 0,
    cpuMax: 0,
    memUsedMaxGiB: 0,
    diskGB: 0,
    egressGB: 0,
    instanceType: null,
    cost: { compute: 0, storage: 0, ipv4: 0, egress: 0 },
  };
}

function bucket(vpsId, day) {
  const db = store.db;
  db.usage[vpsId] ||= {};
  db.usage[vpsId][day] ||= emptyBucket();
  return db.usage[vpsId][day];
}

function logEvent(vpsId, type, detail, ts = Date.now()) {
  const db = store.db;
  db.events ||= [];
  db.events.push({ ts, vpsId, type, detail });
  if (db.events.length > 5000) db.events.splice(0, db.events.length - 5000);
}

function effectiveType(vps) {
  return pricing.byType(vps.instanceType);
}

// Egress free tier (100 GB/month) is per account, so track it across all VPS.
function chargeEgress(gb, ts) {
  const db = store.db;
  db.egressByMonth ||= {};
  const m = monthKey(ts);
  const before = db.egressByMonth[m] || 0;
  const after = before + gb;
  db.egressByMonth[m] = after;
  const billable = Math.max(0, after - pricing.EGRESS_FREE_GB_PER_MONTH) - Math.max(0, before - pricing.EGRESS_FREE_GB_PER_MONTH);
  return billable * pricing.EGRESS_USD_PER_GB;
}

// Accrue cost for `dt` seconds ending at `ts`, using the metrics in `m`.
function accrue(vps, m, dt, egressGB, ts) {
  const type = effectiveType(vps);
  const b = bucket(vps.id, dayKey(ts));
  const hours = dt / 3600;
  const memPct = m.memTotalGiB > 0 ? (m.memUsedGiB / m.memTotalGiB) * 100 : 0;

  b.seconds += dt;
  b.cpuPctSec += m.cpuPct * dt;
  b.memPctSec += memPct * dt;
  b.cpuMax = Math.max(b.cpuMax, m.cpuPct);
  b.memUsedMaxGiB = Math.max(b.memUsedMaxGiB, m.memUsedGiB);
  b.diskGB = m.diskTotalGB;
  b.egressGB += egressGB;
  b.instanceType = type.type;

  b.cost.compute += type.hourly * hours;
  b.cost.storage += (m.diskTotalGB * pricing.EBS_GP3_USD_PER_GB_MONTH * hours) / pricing.HOURS_PER_MONTH;
  b.cost.ipv4 += pricing.PUBLIC_IPV4_USD_PER_HOUR * hours;
  b.cost.egress += chargeEgress(egressGB, ts);
}

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// Validate and normalise a heartbeat sent by the VPS agent.
function parseMetrics(body) {
  return {
    hostname: String(body.hostname || '').slice(0, 100),
    os: String(body.os || '').slice(0, 100),
    arch: pricing.normArch(body.arch),
    vcpu: Math.round(num(body.vcpu, 1, 512)),
    cpuPct: num(body.cpu_pct, 0, 100),
    memTotalGiB: num(body.mem_total_kb, 0, 1e10) / 1048576,
    memUsedGiB: num(body.mem_used_kb, 0, 1e10) / 1048576,
    diskTotalGB: num(body.disk_total_bytes, 0, 1e15) / 1e9,
    diskUsedGB: num(body.disk_used_bytes, 0, 1e15) / 1e9,
    txBytes: num(body.net_tx_bytes, 0, 1e18),
    rxBytes: num(body.net_rx_bytes, 0, 1e18),
    uptimeSec: num(body.uptime_sec, 0, 1e10),
  };
}

function ingest(vps, body, ts = Date.now()) {
  const m = parseMetrics(body);

  // Map the VPS spec to the cheapest equivalent EC2 instance.
  const fit = pricing.cheapestFit(m.vcpu, m.memTotalGiB, m.arch);
  if (!vps.instanceType) {
    logEvent(vps.id, 'connected', `Agent terhubung dari ${m.hostname || 'host tidak dikenal'}. Disetarakan dengan ${fit.type}.`, ts);
  } else if (fit.type !== vps.instanceType) {
    logEvent(vps.id, 'resized', `Spesifikasi berubah (${m.vcpu} vCPU, ${m.memTotalGiB.toFixed(1)} GiB). Mapping ${vps.instanceType} -> ${fit.type}.`, ts);
  }
  vps.instanceType = fit.type;

  const prev = vps.last;
  if (prev) {
    const dt = (ts - prev.ts) / 1000;
    if (dt > MAX_GAP_SEC) {
      logEvent(vps.id, 'gap', `Tidak ada data selama ${Math.round(dt / 60)} menit (VPS atau agent offline). Tidak ditagih.`, ts);
    } else if (dt > 0) {
      let txDelta = m.txBytes - prev.txBytes;
      if (txDelta < 0) {
        txDelta = 0; // counter reset (reboot)
        logEvent(vps.id, 'reboot', 'Counter network ter-reset (kemungkinan reboot).', ts);
      }
      accrue(vps, m, dt, txDelta / 1e9, ts);
    }
  }

  vps.last = { ts, ...m };
  vps.lastSeen = ts;
  store.save();
  return { instanceType: effectiveType(vps).type };
}

// ---------- Reporting ----------

function daysBack(n, ts = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(ts - i * 86400000));
  return out;
}

function bucketTotal(b) {
  return b ? b.cost.compute + b.cost.storage + b.cost.ipv4 + b.cost.egress : 0;
}

function dailySeries(days, vpsId = null) {
  const db = store.db;
  const ids = vpsId ? [vpsId] : Object.keys(db.usage);
  return days.map((d) => {
    const row = { date: d, total: 0, compute: 0, storage: 0, ipv4: 0, egress: 0 };
    for (const id of ids) {
      const b = db.usage[id]?.[d];
      if (!b) continue;
      for (const k of Object.keys(SERVICES)) row[k] += b.cost[k];
      row.total += bucketTotal(b);
    }
    return row;
  });
}

function totalSpent() {
  let sum = 0;
  for (const days of Object.values(store.db.usage)) for (const b of Object.values(days)) sum += bucketTotal(b);
  return sum;
}

function balance() {
  const s = store.db.settings;
  const topups = (s.topups || []).reduce((a, t) => a + t.amount, 0);
  const credit = s.startingCreditUsd + topups;
  const spent = totalSpent();
  return { credit, spent, remaining: credit - spent };
}

function monthToDate(ts = Date.now()) {
  const m = monthKey(ts);
  const byVps = {};
  const byService = { compute: 0, storage: 0, ipv4: 0, egress: 0 };
  let total = 0;
  for (const [id, days] of Object.entries(store.db.usage)) {
    for (const [d, b] of Object.entries(days)) {
      if (!d.startsWith(m)) continue;
      byVps[id] = (byVps[id] || 0) + bucketTotal(b);
      for (const k of Object.keys(byService)) byService[k] += b.cost[k];
      total += bucketTotal(b);
    }
  }
  return { month: m, total, byVps, byService };
}

// Forecast = month-to-date + current hourly run rate * hours left in the month.
function forecast(ts = Date.now()) {
  const mtd = monthToDate(ts);
  const d = new Date(ts);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const hoursLeft = (end - ts) / 3600000;
  let runRate = 0;
  for (const v of store.db.vps) {
    if (!isOnline(v, ts)) continue;
    const type = effectiveType(v);
    if (!type) continue;
    runRate += type.hourly + pricing.PUBLIC_IPV4_USD_PER_HOUR;
    runRate += ((v.last?.diskTotalGB || 0) * pricing.EBS_GP3_USD_PER_GB_MONTH) / pricing.HOURS_PER_MONTH;
  }
  // add average egress per hour over the last 7 days
  const egress7 = dailySeries(daysBack(7, ts)).reduce((a, r) => a + r.egress, 0);
  runRate += egress7 / (7 * 24);
  return { mtd: mtd.total, runRatePerHour: runRate, forecast: mtd.total + runRate * hoursLeft };
}

// A sample VPS counts only toward the projection, and only when its projection is switched on.
function isOnline(v, ts = Date.now()) {
  if (v.demo) return !!v.active;
  return !!v.lastSeen && ts - v.lastSeen < 3 * 60 * 1000;
}

function vpsStats(vpsId, nDays = 14, ts = Date.now()) {
  const usage = store.db.usage[vpsId] || {};
  let seconds = 0, cpu = 0, mem = 0, cpuMax = 0, memMax = 0, cost = 0, days = 0;
  for (const d of daysBack(nDays, ts)) {
    const b = usage[d];
    if (!b || !b.seconds) continue;
    days++;
    seconds += b.seconds;
    cpu += b.cpuPctSec;
    mem += b.memPctSec;
    cpuMax = Math.max(cpuMax, b.cpuMax);
    memMax = Math.max(memMax, b.memUsedMaxGiB);
    cost += bucketTotal(b);
  }
  return {
    days,
    hours: seconds / 3600,
    cpuAvg: seconds ? cpu / seconds : 0,
    memAvgPct: seconds ? mem / seconds : 0,
    cpuMax,
    memUsedMaxGiB: memMax,
    cost,
  };
}

// Anomaly = a completed day where a service cost > 1.5x its 14-day baseline and the jump is > $0.05.
function detectAnomalies({ fromDays = 7, ts = Date.now(), minImpact = 0.05, ratio = 1.5 } = {}) {
  const db = store.db;
  const today = dayKey(ts);
  const out = [];
  for (const v of db.vps) {
    const usage = db.usage[v.id] || {};
    for (const d of daysBack(fromDays + 1, ts)) {
      if (d === today) continue; // incomplete day
      const b = usage[d];
      if (!b) continue;
      const dTs = Date.parse(d + 'T00:00:00Z');
      const base = daysBack(14, dTs - 86400000).map((x) => usage[x]).filter((x) => x && x.seconds > 0);
      if (base.length < 3) continue;
      for (const k of Object.keys(SERVICES)) {
        const avg = base.reduce((a, x) => a + x.cost[k], 0) / base.length;
        const actual = b.cost[k];
        const impact = actual - avg;
        if (impact > minImpact && actual > avg * ratio) {
          out.push({
            id: `${v.id.slice(0, 6)}-${d}-${k}`,
            date: d,
            vpsId: v.id,
            vpsName: v.name,
            service: SERVICES[k],
            serviceKey: k,
            expected: avg,
            actual,
            impact,
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.impact - a.impact);
}

function eventsAround(vpsId, date, padDays = 1) {
  const start = Date.parse(date + 'T00:00:00Z') - padDays * 86400000;
  const end = Date.parse(date + 'T00:00:00Z') + (1 + padDays) * 86400000;
  return (store.db.events || []).filter((e) => e.vpsId === vpsId && e.ts >= start && e.ts < end);
}

// Rightsizing: size for max memory used +25% and max CPU at <= 70% of the new size.
function rightsize(v) {
  if (v.demo) return null; // sample VPS has no usage metrics
  const cur = effectiveType(v);
  if (!cur) return null;
  const s = vpsStats(v.id, 14);
  if (s.hours < 24) return { vps: v, current: cur, stats: s, enoughData: false };
  const vcpuNeeded = Math.max(1, Math.ceil(((s.cpuMax / 100) * cur.vcpu) / 0.7));
  const memNeeded = Math.max(0.5, s.memUsedMaxGiB * 1.25);
  const rec = pricing.cheapestFit(vcpuNeeded, memNeeded, cur.arch, 1);
  const monthlyNow = cur.hourly * pricing.HOURS_PER_MONTH;
  const monthlyRec = rec.hourly * pricing.HOURS_PER_MONTH;
  return {
    vps: v,
    current: cur,
    recommended: rec,
    stats: s,
    enoughData: true,
    monthlySavings: Math.max(0, monthlyNow - monthlyRec),
    idle: s.cpuMax < 5 && s.cpuAvg < 2,
  };
}

module.exports = {
  SERVICES,
  dayKey,
  monthKey,
  round,
  ingest,
  accrue,
  logEvent,
  effectiveType,
  daysBack,
  dailySeries,
  bucketTotal,
  balance,
  monthToDate,
  forecast,
  isOnline,
  vpsStats,
  detectAnomalies,
  eventsAround,
  rightsize,
};
