'use strict';
// Optional AI model integration (any OpenAI-compatible Chat Completions API).
// Flow: primary model -> backup model -> rule-based agent.
// The model only (1) picks a tool and (2) writes a short summary. Every number comes from the tools.
const store = require('./store');
const agent = require('./agent');

const TIMEOUT_MS = 20000;

const PRESETS = {
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama (lokal)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '' },
};

function emptySlot() {
  return { enabled: false, provider: 'gemini', baseUrl: PRESETS.gemini.baseUrl, model: PRESETS.gemini.model, apiKey: '' };
}

function settings() {
  const s = store.db.settings;
  s.ai ||= { primary: emptySlot(), backup: { ...emptySlot(), provider: 'groq', baseUrl: PRESETS.groq.baseUrl, model: PRESETS.groq.model } };
  return s.ai;
}

// Environment variables override the stored keys (recommended for deployment).
function slot(name) {
  const s = { ...settings()[name] };
  const env = process.env[name === 'primary' ? 'AI_PRIMARY_API_KEY' : 'AI_BACKUP_API_KEY'];
  if (env) s.apiKey = env;
  return s;
}

function masked(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function publicSettings() {
  const out = {};
  for (const n of ['primary', 'backup']) {
    const s = slot(n);
    out[n] = { enabled: s.enabled, provider: s.provider, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, keyHint: masked(s.apiKey), keyFromEnv: !!process.env[n === 'primary' ? 'AI_PRIMARY_API_KEY' : 'AI_BACKUP_API_KEY'] };
  }
  out.presets = PRESETS;
  return out;
}

function validUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
}

function update(name, b) {
  if (!['primary', 'backup'].includes(name)) throw Object.assign(new Error('Slot tidak dikenal'), { status: 400 });
  const s = settings()[name];
  if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
  if (b.provider !== undefined) {
    if (!PRESETS[b.provider]) throw Object.assign(new Error('Provider tidak dikenal'), { status: 400 });
    s.provider = b.provider;
  }
  if (b.baseUrl !== undefined) {
    const u = String(b.baseUrl).trim().replace(/\/+$/, '');
    if (u && !validUrl(u)) throw Object.assign(new Error('Base URL tidak valid'), { status: 400 });
    s.baseUrl = u;
  }
  if (b.model !== undefined) s.model = String(b.model).trim().slice(0, 200);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) s.apiKey = b.apiKey.trim().slice(0, 500);
  if (b.clearKey === true) s.apiKey = '';
  store.save();
  return publicSettings();
}

async function chat(s, messages, json) {
  if (!s.baseUrl || !s.model) throw new Error('Base URL atau model belum diisi');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    const body = { model: s.model, messages, temperature: 0.2 };
    if (json) body.response_format = { type: 'json_object' };
    const r = await fetch(`${s.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Respons model kosong');
    return content.trim();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Timeout ${TIMEOUT_MS / 1000} detik` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function toolList() {
  return Object.entries(agent.TOOLS).map(([k, t]) => `- ${k}: ${t.desc}`).join('\n');
}

// Plain-text view of a reply, used as grounding data for the summary.
function replyAsText(r) {
  return r.blocks
    .map((b) => {
      if (b.type === 'table') return [b.columns.join(' | '), ...b.rows.map((x) => x.join(' | '))].join('\n');
      if (b.type === 'ul') return b.items.map((i) => '- ' + i).join('\n');
      return b.text;
    })
    .join('\n')
    .slice(0, 6000);
}

async function plan(s, text) {
  const out = await chat(
    s,
    [
      {
        role: 'system',
        content: `Kamu adalah router untuk FinOps Agent. Pilih SATU tool yang paling cocok untuk pertanyaan pengguna.\nTools:\n${toolList()}\nBalas hanya JSON: {"tool":"<nama>","days":<angka atau null>}`,
      },
      { role: 'user', content: text },
    ],
    true
  );
  const m = out.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : out);
  if (!agent.TOOLS[j.tool]) throw new Error(`Tool tidak dikenal: ${j.tool}`);
  const days = Number(j.days);
  return { tool: j.tool, days: Number.isFinite(days) && days >= 1 && days <= 90 ? Math.round(days) : null };
}

async function summarize(s, text, reply) {
  return chat(s, [
    {
      role: 'system',
      content:
        'Kamu FinOps Agent. Tulis ringkasan 1-3 kalimat dalam Bahasa Indonesia (istilah IT tetap English) yang menjawab pertanyaan pengguna. ' +
        'Gunakan HANYA angka yang ada di DATA. Jangan menambah angka, tebakan, atau saran yang tidak didukung DATA. Tanpa heading, tanpa tabel.',
    },
    { role: 'user', content: `Pertanyaan: ${text}\n\nDATA:\n${replyAsText(reply)}` },
  ]);
}

async function runWith(name, text) {
  const s = slot(name);
  const p = await plan(s, text);
  const reply = agent.runTool(p.tool, text, p.days ? { days: p.days } : {});
  const summary = await summarize(s, text, reply);
  reply.blocks.unshift({ type: 'p', text: summary.replace(/\s+\n/g, '\n').slice(0, 1500) });
  reply.steps = [`Model ${s.model} memilih tool \`${p.tool}\`${p.days ? ` (${p.days} hari)` : ''}`, ...reply.steps, `Model ${s.model} merangkum hasil tool`];
  return reply;
}

// Main entry: returns { reply, engine }.
async function respond(text) {
  const notes = [];
  for (const name of ['primary', 'backup']) {
    const s = slot(name);
    if (!s.enabled) continue;
    try {
      const reply = await runWith(name, text);
      if (notes.length) reply.steps.unshift(...notes);
      return { reply, engine: `${name}:${s.model}` };
    } catch (e) {
      notes.push(`Model ${name === 'primary' ? 'utama' : 'backup'} (${s.model || '-'}) gagal: ${e.message}`);
    }
  }
  const reply = agent.respond(text);
  if (notes.length) reply.steps.unshift(...notes, 'Memakai rule-based agent sebagai fallback');
  return { reply, engine: 'rule-based' };
}

async function test(name) {
  const s = slot(name);
  const started = Date.now();
  const out = await chat(s, [{ role: 'user', content: 'Balas dengan satu kata: OK' }]);
  return { ok: true, model: s.model, latencyMs: Date.now() - started, sample: out.slice(0, 50) };
}

module.exports = { respond, publicSettings, update, test, PRESETS };
