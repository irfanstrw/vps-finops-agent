'use strict';
// Data store. One JSON document, kept either in:
//   - Redis (Upstash REST) when KV_REST_API_URL/UPSTASH_REDIS_REST_URL is set (used on Vercel), or
//   - a local file (data/db.json) for local / VPS runs.
// Call `await load()` before using `db`, and `await persist()` after changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.REDIS_KEY || 'finops:db';
const ON_VERCEL = !!process.env.VERCEL;
const FILE = process.env.DATA_FILE || (ON_VERCEL ? '/tmp/finops-db.json' : path.join(__dirname, '..', 'data', 'db.json'));

const backend = REDIS_URL && REDIS_TOKEN ? 'redis' : ON_VERCEL ? 'ephemeral' : 'file';

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function defaults() {
  return {
    settings: { startingCreditUsd: 500 },
    vps: [],
    usage: {}, // usage[vpsId][YYYY-MM-DD] = daily bucket
    chats: [],
    artifacts: [],
    contextFiles: [],
    automations: [
      {
        id: newId(),
        name: 'Cek anomali harian',
        type: 'anomaly',
        description: 'Cari lonjakan biaya 1 hari terakhir dibanding baseline 14 hari sebelumnya.',
        enabled: true,
        intervalHours: 24,
        params: {},
        lastRun: null,
        lastResult: null,
      },
      {
        id: newId(),
        name: 'Peringatan budget bulanan',
        type: 'budget',
        description: 'Peringatan jika forecast biaya bulan ini melewati budget.',
        enabled: true,
        intervalHours: 24,
        params: { monthlyBudgetUsd: 50 },
        lastRun: null,
        lastResult: null,
      },
      {
        id: newId(),
        name: 'Review rightsizing mingguan',
        type: 'rightsizing',
        description: 'Cari VPS yang kebesaran atau idle dan hitung potensi penghematan.',
        enabled: false,
        intervalHours: 168,
        params: {},
        lastRun: null,
        lastResult: null,
      },
    ],
  };
}

let db = defaults();
let dirty = false;
let loadedOnce = false;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Redis error: ${data.error || r.status}`);
  return data.result;
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // Do not overwrite a file we failed to parse.
    console.error(`Failed to read ${FILE}. Fix or move the file, then restart.`);
    throw e;
  }
}

function writeFile() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

// Load the document. For the file backend this only happens once (the process owns the file).
// For Redis it reloads on every request so separate serverless instances see each other's writes.
async function load() {
  if (backend === 'file' && loadedOnce) return db;
  const raw = backend === 'redis' ? await redis(['GET', REDIS_KEY]).then((s) => (s ? JSON.parse(s) : null)) : readFile();
  db = raw ? { ...defaults(), ...raw } : defaults();
  dirty = !raw;
  loadedOnce = true;
  return db;
}

let timer = null;
// Mark data as changed. The file backend also writes it shortly after.
function save() {
  dirty = true;
  if (backend !== 'file' || timer) return;
  timer = setTimeout(() => {
    timer = null;
    persist().catch((e) => console.error('Failed to save data:', e));
  }, 500);
}

async function persist() {
  if (!dirty) return;
  dirty = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (backend === 'redis') await redis(['SET', REDIS_KEY, JSON.stringify(db)]);
  else writeFile();
}

module.exports = {
  backend,
  get db() {
    return db;
  },
  load,
  save,
  persist,
  newId,
};
