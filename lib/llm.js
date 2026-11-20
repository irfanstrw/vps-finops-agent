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

async function chat(s, messages, json, temperature = 0.2) {
  if (!s.baseUrl || !s.model) throw new Error('Base URL atau model belum diisi');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    const body = { model: s.model, messages, temperature };
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
      if (b.type === 'stats') return b.items.map((i) => `${i.label}: ${i.value}`).join('\n');
      if (b.type === 'chart' || b.type === 'follow') return '';
      return b.text || '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

// Riwayat singkat percakapan, supaya model paham pertanyaan lanjutan ("yang tadi", "kalau di Azure?").
function historyText(history = []) {
  return history
    .slice(-6)
    .map((m) => (m.role === 'user' ? `Pengguna: ${m.text}` : `Agent: ${m.reply?.title || ''}. ${m.reply ? replyAsText(m.reply).slice(0, 400) : ''}`))
    .join('\n');
}

async function plan(s, text, history) {
  const ctx = historyText(history);
  const out = await chat(
    s,
    [
      {
        role: 'system',
        content: `Kamu adalah router untuk FinOps Agent. Pilih SATU tool yang paling cocok untuk pertanyaan terakhir pengguna, dengan memperhatikan percakapan sebelumnya.\nTools:\n${toolList()}\nBalas hanya JSON: {"tool":"<nama>","days":<angka atau null>,"query":"<pertanyaan yang sudah dilengkapi dari konteks>"}`,
      },
      { role: 'user', content: `${ctx ? `Percakapan sebelumnya:\n${ctx}\n\n` : ''}Pertanyaan terakhir: ${text}` },
    ],
    true
  );
  const m = out.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : out);
  if (!agent.TOOLS[j.tool]) throw new Error(`Tool tidak dikenal: ${j.tool}`);
  const days = Number(j.days);
  const query = typeof j.query === 'string' && j.query.trim() ? j.query.trim().slice(0, 500) : text;
  return { tool: j.tool, query, days: Number.isFinite(days) && days >= 1 && days <= 90 ? Math.round(days) : null };
}

// Model menulis jawaban sendiri dari DATA tool: pembuka yang langsung menjawab, insight, dan saran langkah.
// Blok angka (stats, grafik, tabel) dari tool tetap dipakai, sedangkan paragraf bawaan tool dibuang supaya tidak dobel.
// Kalimat yang berupa tawaran atau pertanyaan balik dari agent ("Apakah Anda ingin mematikan server?",
// "Mau saya bantu...", "Haruskah server dimatikan?"). Saran lanjutan harus kalimat yang diketik pengguna.
const OFFER_RE = /^(apakah|apa (anda|kamu)|mau(kah)?|ingin(kah)?|perlu(kah)?|bolehkah|haruskah|bisakah saya|saya bisa|saya dapat|akan saya)\b|\b(anda|kamu) (ingin|mau|perlu)\b|\b(saya|aku) (bisa|dapat|akan) (bantu|matikan|hapus|buat)/i;

// Model kadang mengirim JSON rusak (kurung array salah, koma lebih, teks di luar JSON).
// Coba parse normal dulu; kalau gagal, ambil tiap field dengan pola, supaya JSON mentah tidak pernah tampil ke pengguna.
function parseLoose(out) {
  const raw = String(out || '');
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : raw);
    if (j && typeof j === 'object') return j;
  } catch {
    /* lanjut ke cara longgar */
  }
  const str = (s) => {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      return s.replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  };
  const QUOTED = /"((?:[^"\\]|\\.)*)"/g;
  const section = (key, nextKeys) => {
    const i = raw.search(new RegExp(`"${key}"\\s*:`));
    if (i < 0) return '';
    const rest = raw.slice(i + key.length + 2);
    const ends = nextKeys.map((k) => rest.search(new RegExp(`"${k}"\\s*:`))).filter((x) => x >= 0);
    return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
  };
  const list = (key, nextKeys) => [...section(key, nextKeys).matchAll(QUOTED)].map((x) => str(x[1])).filter((x) => x.trim());
  const ans = section('answer', ['points', 'follow']).match(/:\s*"((?:[^"\\]|\\.)*)"/);
  if (ans) return { answer: str(ans[1]), points: list('points', ['follow', 'answer']), follow: list('follow', ['points', 'answer']) };
  // Bukan JSON sama sekali: pakai teks biasa, tapi jangan pernah teks yang masih berbentuk JSON.
  return /^\s*[{[]/.test(raw) ? {} : { answer: raw };
}

async function compose(s, text, reply, history) {
  const ctx = historyText(history);
  const out = await chat(
    s,
    [
      {
        role: 'system',
        content:
          'Kamu FinOps Agent, asisten biaya cloud yang ramah dan to the point. Jawab dalam Bahasa Indonesia santai tapi rapi (istilah IT tetap English). ' +
          'Gunakan HANYA angka yang ada di DATA, jangan mengarang angka. Boleh menyimpulkan, membandingkan, dan memberi saran praktis yang didukung DATA. ' +
          'Variasikan gaya kalimat, jangan mengulang kalimat pembuka yang sama dengan jawaban sebelumnya. ' +
          'Jangan menyalin tabel; tabel dan grafik sudah ditampilkan terpisah di bawah jawabanmu. ' +
          'Jangan bertanya balik ke pengguna dan jangan menawarkan tindakan ("Apakah Anda ingin...", "Mau saya..."). Kamu read-only dan tidak bisa mengubah server. ' +
          'Balas JSON: {"answer":"2-5 kalimat, boleh pakai **tebal** untuk angka penting","points":["0-3 poin insight atau saran singkat"],"follow":["2-3 pertanyaan lanjutan yang DIKETIK PENGGUNA ke agent, bentuk perintah atau pertanyaan pendek, contoh: \\"Forecast bulan ini\\", \\"Berapa hemat kalau disk dihapus?\\""]}',
      },
      { role: 'user', content: `${ctx ? `Percakapan sebelumnya:\n${ctx}\n\n` : ''}Pertanyaan: ${text}\n\nDATA:\n${replyAsText(reply)}` },
    ],
    true,
    0.7
  );
  const j = parseLoose(out);
  if (!j.answer) throw new Error('Format jawaban model tidak bisa dibaca');
  // *miring* tunggal dibuang (tidak didukung tampilan), **tebal** dipertahankan.
  const clean = (x, n) => String(x || '').replace(/\s+\n/g, '\n').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2').replace(/\.img\b/g, '').trim().slice(0, n);
  // Kalimat terakhir jawaban yang berupa tawaran atau pertanyaan balik dibuang.
  const answer = clean(j.answer, 1500)
    .split(/(?<=[.!?])\s+/)
    .filter((sent, i, all) => !(i === all.length - 1 && all.length > 1 && (OFFER_RE.test(sent) || /\?\s*$/.test(sent))))
    .join(' ');
  return {
    answer,
    points: (Array.isArray(j.points) ? j.points : []).map((x) => clean(x, 240)).filter((x) => x && !/\?\s*$/.test(x)).slice(0, 3),
    // Saran lanjutan adalah kalimat yang diketik pengguna. Buang yang berupa tawaran atau pertanyaan dari agent.
    follow: (Array.isArray(j.follow) ? j.follow : [])
      .map((x) => clean(x, 90))
      .filter((x) => x && !OFFER_RE.test(x))
      .slice(0, 3),
  };
}

async function runWith(name, text, history) {
  const s = slot(name);
  const p = await plan(s, text, history);
  const reply = agent.runTool(p.tool, p.query, p.days ? { days: p.days } : {});
  const c = await compose(s, text, reply, history);
  if (!c.answer) throw new Error('Jawaban model kosong');
  // Buang paragraf dan saran bawaan tool (sudah diganti tulisan model), pertahankan blok data.
  const data = reply.blocks.filter((b) => !['p', 'h', 'ul', 'follow'].includes(b.type));
  const blocks = [{ type: 'p', text: c.answer }];
  if (c.points.length) blocks.push({ type: 'ul', items: c.points });
  blocks.push(...data);
  const follow = c.follow.length ? c.follow : reply.blocks.find((b) => b.type === 'follow')?.items;
  if (follow?.length) blocks.push({ type: 'follow', items: follow });
  reply.blocks = blocks;
  reply.steps = [`Model ${s.model} memilih tool \`${p.tool}\`${p.days ? ` (${p.days} hari)` : ''}`, ...reply.steps, `Model ${s.model} menulis jawaban dari hasil tool`];
  return reply;
}

// Main entry: returns { reply, engine }.
async function respond(text, history = []) {
  const notes = [];
  for (const name of ['primary', 'backup']) {
    const s = slot(name);
    if (!s.enabled) continue;
    try {
      const reply = await runWith(name, text, history);
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

module.exports = { respond, publicSettings, update, test, PRESETS, parseLoose };
