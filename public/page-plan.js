'use strict';
// Planning: hitung biaya server sebelum membuat apa pun, tanpa akun cloud dan tanpa mengeluarkan uang.
//   1. Rekomendasi: isi budget dan kebutuhan, sistem memilih spesifikasi dari aturan tetap dan daftar harga.
//   2. Custom: daftar server di AWS, Azure, atau Google Cloud dari katalog lengkap, lihat biaya per bulan dan 12 bulan,
//      lalu unduh template Terraform.
// Hasil planning tidak mengubah budget, forecast, atau data server.
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml, confirmInline } = A;
  const C = window.Charts;
  const L = window.Logos;

  const IDS = ['aws', 'azure', 'gcp'];
  const COLOR = { aws: 'var(--p-aws)', azure: 'var(--p-azure)', gcp: 'var(--p-gcp)' };
  let cat = null;
  let items = [];
  let timer = null;
  let lastCalc = null;
  let tab = 'recommend';
  const form = { budget: 25, workload: 'webapp', scale: 'small', storageGB: 10, providers: [...IDS], arch: 'any' };
  const ARCH = { any: ['Bebas', 'Pilih yang paling hemat'], x86_64: ['x86_64', 'Intel atau AMD, paling kompatibel'], arm64: ['arm64', 'Lebih hemat, cek kompatibilitas aplikasi'] };

  const DEFAULT_TYPE = { aws: 't3a.small', azure: 'Standard_B1ms', gcp: 'e2-small' };

  // ---------- rekomendasi ----------
  // Pilihan berupa kartu radio/checkbox asli (bisa Tab, Space, dan dibaca pembaca layar), bukan dropdown,
  // supaya semua opsi dan penjelasannya terlihat sekaligus.
  const choice = (type, name, value, checked, title, note, extra = '') =>
    `<label class="opt"><input type="${type}" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span class="opt-b">${extra}<b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</span></label>`;

  function recForm() {
    const wl = Object.entries(cat.workloads).map(([k, v]) => choice('radio', 'rWork', k, form.workload === k, v.label, v.note)).join('');
    const sc = Object.entries(cat.scales).map(([k, v]) => choice('radio', 'rScale', k, form.scale === k, v.label, v.note)).join('');
    const prov = IDS.map((id) => choice('checkbox', 'rProv', id, form.providers.includes(id), cat.providers[id].label, cat.providers[id].region.name, L.badge(id, 'logo sm'))).join('');
    const ar = Object.entries(ARCH).map(([k, v]) => choice('radio', 'rArch', k, form.arch === k, v[0], v[1])).join('');
    return `<form id="recForm" class="rec-form2">
      <fieldset class="step"><legend><span class="step-n">1</span>Jenis aplikasi</legend><div class="opts opts-3">${wl}</div></fieldset>
      <fieldset class="step"><legend><span class="step-n">2</span>Skala pemakaian</legend><div class="opts opts-3">${sc}</div></fieldset>
      <fieldset class="step"><legend><span class="step-n">3</span>Budget dan penyimpanan</legend>
        <div class="step-row">
          <label>Budget per bulan (USD)<span class="inp-pre"><i>$</i><input type="number" id="rBudget" min="1" step="any" value="${esc(form.budget)}" required></span></label>
          <label>Kapasitas penyimpanan data (GB)<input type="number" id="rStore" min="0" step="1" value="${esc(form.storageGB)}"></label>
        </div>
        <div class="quick" role="group" aria-label="Pilihan cepat budget">${[10, 25, 50, 100].map((v) => `<button type="button" class="btn small${Number(form.budget) === v ? ' on' : ''}" data-budget="${v}" aria-pressed="${Number(form.budget) === v}">$${v}</button>`).join('')}</div>
      </fieldset>
      <fieldset class="step"><legend><span class="step-n">4</span>Platform</legend><div class="opts opts-3">${prov}</div></fieldset>
      <details class="step adv"${form.arch !== 'any' ? ' open' : ''}><summary>Pengaturan lanjutan</summary>
        <fieldset><legend>Arsitektur CPU</legend><div class="opts opts-3">${ar}</div></fieldset>
      </details>
      <div class="rec-submit"><button class="btn primary" type="submit">Hitung rekomendasi</button><span class="muted" id="rSum"></span></div>
    </form>`;
  }

  function recResult(r) {
    const req = r.requirement;
    const need = `<div class="stats"><div class="stat"><div class="sv">${req.vcpu} vCPU</div><div class="sl">kebutuhan CPU</div></div><div class="stat"><div class="sv">${req.mem} GiB</div><div class="sl">kebutuhan RAM</div></div><div class="stat"><div class="sv">${req.diskGB} GB</div><div class="sl">disk</div></div></div>`;
    const best = r.best
      ? `<div class="pick">${L.badge(r.best.provider, 'logo lg')}<div><div class="label muted">Disarankan</div><div class="pick-name">${esc(r.best.label)} <code>${esc(r.best.type)}</code>${r.best.count > 1 ? ` x ${r.best.count}` : ''}</div>
          <div class="big">${usd(r.best.monthly)}<small> per bulan</small></div><p class="muted" style="margin:0">${esc(r.best.region.name)}. Sisa budget ${usd(r.best.left)}.</p></div></div>
         <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
         <div class="row"><button class="btn" type="button" data-use="best">Pakai di Custom</button></div>`
      : `<div class="note"><b>Budget ${usd(r.budget)} belum cukup.</b> Pilihan terdekat butuh ${usd(r.options[0]?.monthly || 0)} per bulan, kurang ${usd(r.cheapestGap || 0)}. Turunkan kebutuhan atau naikkan budget.</div>`;
    const chart = C.hbars({ rows: r.options.slice(0, 8).map((o) => ({ label: `${o.label} ${o.type}`, sub: `${o.vcpu} vCPU, ${o.memGiB} GiB`, value: o.monthly, color: COLOR[o.provider] })), label: 'Perbandingan biaya per bulan terhadap budget', ref: r.budget, refLabel: `budget ${usd(r.budget)}` });
    const table = `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Platform</th><th scope="col">Tipe</th><th scope="col">Spesifikasi</th><th scope="col" class="num">Server</th><th scope="col" class="num">Disk dan IP</th><th scope="col" class="num">Per bulan</th><th scope="col">Budget</th><th scope="col"><span class="sr-only">Aksi</span></th></tr></thead><tbody>${r.options
      .map((o, i) => `<tr><td><span class="cell-logo">${L.badge(o.provider, 'logo xs')}${esc(o.label)}</span></td><td><code>${esc(o.type)}</code>${o.count > 1 ? ` x ${o.count}` : ''}</td><td>${o.vcpu} vCPU, ${o.memGiB} GiB, ${esc(o.arch)}</td><td class="num">${usd(o.parts.server)}</td><td class="num">${usd(o.parts.disk + o.parts.ip)}</td><td class="num"><b>${usd(o.monthly)}</b></td><td>${o.fits ? '<span class="s-ok">Sesuai budget</span>' : '<span class="s-alert">Melebihi budget</span>'}</td><td><button class="btn small" type="button" data-use="${i}">Pakai</button></td></tr>`)
      .join('')}</tbody></table></div>`;
    return `<h2>Kebutuhan</h2>${need}<div class="rec-grid"><div class="card">${best}</div><div class="card"><h3>Perbandingan per bulan</h3>${chart}</div></div><h2 style="margin-top:18px">Semua pilihan</h2>${table}`;
  }

  async function runRec(main) {
    const out = $('#recOut');
    out.innerHTML = '<p class="muted" role="status">Menghitung...</p>';
    try {
      const r = await api('POST', '/api/plan/recommend', form);
      out.innerHTML = recResult(r);
      C.bind(out);
      out.querySelectorAll('[data-use]').forEach((b) =>
        b.addEventListener('click', () => {
          const o = b.dataset.use === 'best' ? r.best : r.options[Number(b.dataset.use)];
          items = JSON.parse(JSON.stringify(o.items));
          filt = [];
          tab = 'build';
          render(main);
          toast('Dimuat ke Custom');
        })
      );
    } catch (e) {
      out.innerHTML = `<p class="err" role="alert">${esc(e.message)}</p>`;
    }
  }

  function bindRec(main) {
    const val = (n) => main.querySelector(`input[name="${n}"]:checked`)?.value;
    const read = () => {
      form.budget = Number($('#rBudget').value);
      form.workload = val('rWork') || form.workload;
      form.scale = val('rScale') || form.scale;
      form.storageGB = Number($('#rStore').value) || 0;
      form.arch = val('rArch') || 'any';
      form.providers = [...main.querySelectorAll('input[name="rProv"]:checked')].map((x) => x.value);
      $('#rSum').textContent = `${cat.workloads[form.workload].label}, skala ${cat.scales[form.scale].label.toLowerCase()}, budget $${form.budget || 0}`;
      main.querySelectorAll('[data-budget]').forEach((b) => { const on = Number(b.dataset.budget) === form.budget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    };
    main.querySelectorAll('[data-budget]').forEach((b) => b.addEventListener('click', () => { $('#rBudget').value = b.dataset.budget; read(); }));
    $('#recForm').addEventListener('change', read);
    $('#recForm').addEventListener('input', read);
    read();
    $('#recForm').addEventListener('submit', (e) => {
      e.preventDefault();
      read();
      if (!form.providers.length) return toast('Pilih minimal satu platform');
      runRec(main);
    });
    runRec(main);
  }

  // ---------- custom ----------
  // Katalog berisi ratusan sampai ribuan tipe per platform. Pilihan tipe disaring dulu (cari nama, arsitektur,
  // vCPU, dan RAM minimum), lalu daftar hasil diurutkan dari harga per jam.
  const MAX_OPTS = 150;
  const VCPU = [0, 1, 2, 4, 8, 16, 32, 64];
  const MEM = [0, 1, 2, 4, 8, 16, 32, 64, 128];
  let filt = [];
  const blankFilter = () => ({ q: '', arch: 'any', vcpu: 0, mem: 0 });
  const filterOf = (i) => (filt[i] ||= blankFilter());

  function matches(provider, f) {
    const q = f.q.trim().toLowerCase();
    return cat.providers[provider].instances.filter((t) => (f.arch === 'any' || t.arch === f.arch) && t.vcpu >= f.vcpu && t.memGiB >= f.mem && (!q || t.type.toLowerCase().includes(q)));
  }

  function typeOptions(it, i) {
    const all = matches(it.provider, filterOf(i));
    const list = all.slice(0, MAX_OPTS);
    const cur = cat.providers[it.provider].instances.find((t) => t.type === it.type);
    if (cur && !list.includes(cur)) list.unshift(cur);
    const opt = (t) => `<option value="${esc(t.type)}" ${t.type === it.type ? 'selected' : ''}>${esc(t.type)}: ${t.vcpu} vCPU, ${t.memGiB} GiB, ${esc(t.arch)}, ${usd(t.hourly * 730)}/bln</option>`;
    return { html: list.length ? list.map(opt).join('') : '<option value="">Tidak ada tipe yang cocok</option>', total: all.length, shown: Math.min(all.length, MAX_OPTS) };
  }

  const countText = (o, provider) => (o.total ? `${o.total} dari ${cat.providers[provider].instances.length} tipe cocok${o.total > o.shown ? `, ${o.shown} termurah ditampilkan` : ''}.` : 'Tidak ada tipe yang cocok. Longgarkan saringan.');

  // Satu server = satu kartu dengan langkah bernomor seperti form Rekomendasi.
  function rowHtml(it, i) {
    const t = cat.providers[it.provider].instances.find((x) => x.type === it.type);
    const f = filterOf(i);
    const cost = lastCalc?.rows?.[i]?.monthly;
    const o = typeOptions(it, i);
    const prov = IDS.map((id) => choice('radio', `cProv${i}`, id, it.provider === id, cat.providers[id].label, cat.providers[id].region.name, L.badge(id, 'logo sm'))).join('');
    const sel = (name, vals, cur, fmt) => `<select data-flt="${name}" data-i="${i}">${vals.map((v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select>`;
    return `<article class="res" data-row="${i}">
      <header class="res-h">${L.badge(it.provider, 'logo sm')}<div class="res-t"><b>Server ${i + 1}</b><small>${t ? `${esc(t.type)}, ${t.vcpu} vCPU, ${t.memGiB} GiB, ${esc(t.arch)}` : 'Tipe belum dipilih'}</small></div>
        <span class="res-c">${cost != null ? `${usd(cost)}<small> per bulan</small>` : ''}</span>
        <button class="btn small ghost" type="button" data-rm="${i}" aria-label="Hapus server ${i + 1}">Hapus</button></header>
      <div class="res-b">
        <fieldset class="step"><legend><span class="step-n">1</span>Platform</legend><div class="opts opts-3" data-prov="${i}">${prov}</div></fieldset>
        <fieldset class="step"><legend><span class="step-n">2</span>Tipe server</legend>
          <div class="flt">
            <label class="grow">Cari nama tipe<input type="search" data-flt="q" data-i="${i}" value="${esc(f.q)}" placeholder="${esc(DEFAULT_TYPE[it.provider])}" autocomplete="off"></label>
            <label>Arsitektur${sel('arch', ['any', 'x86_64', 'arm64'], f.arch, (v) => (v === 'any' ? 'Semua' : v))}</label>
            <label>vCPU minimum${sel('vcpu', VCPU, f.vcpu, (v) => (v ? `${v} vCPU` : 'Semua'))}</label>
            <label>RAM minimum${sel('mem', MEM, f.mem, (v) => (v ? `${v} GiB` : 'Semua'))}</label>
          </div>
          <label class="type-pick">Pilih tipe<select data-f="type" data-i="${i}">${o.html}</select></label>
          <p class="muted flt-n" id="fltN${i}" aria-live="polite">${esc(countText(o, it.provider))}</p>
        </fieldset>
        <fieldset class="step"><legend><span class="step-n">3</span>Disk dan jumlah</legend>
          <div class="step-row">
            <label>Disk per server (GB)<input type="number" min="8" step="1" data-f="diskGB" data-i="${i}" value="${esc(it.diskGB ?? 30)}"></label>
            <label>Jumlah server<input type="number" min="1" step="1" data-f="qty" data-i="${i}" value="${esc(it.qty)}"></label>
          </div>
        </fieldset>
      </div>
    </article>`;
  }

  function outHtml(r) {
    if (!r) return '<p class="muted">Tambahkan server untuk melihat perkiraan biaya.</p>';
    const byProv = {};
    for (const x of r.rows) byProv[x.provider] = (byProv[x.provider] || 0) + x.monthly;
    const donut = C.donut({ slices: r.rows.filter((x) => x.monthly > 0).map((x) => ({ label: `${x.label} (${x.detail})`, value: x.monthly })), label: 'Porsi biaya bulanan per sumber daya', center: { top: usd(r.monthly), bottom: 'per bulan' }, size: 140 });
    const prov = Object.keys(byProv).length > 1 ? `<h3 style="margin:16px 0 6px">Per platform</h3>${C.hbars({ rows: Object.entries(byProv).map(([id, v]) => ({ label: cat.providers[id].label, value: v, color: COLOR[id] })), label: 'Biaya per platform' })}` : '';
    const growth = C.line({ rows: [{ date: 'Bulan 0', label: '0', v: 0 }, ...r.growth.map((g) => ({ date: `Bulan ${g.month}`, label: `Bln ${g.month}`, v: g.cumulative }))], label: 'Biaya kumulatif 12 bulan', height: 170, valueLabel: 'Total' });
    return `<div class="label muted">Perkiraan biaya per bulan</div>
      <div class="big">${usd(r.monthly)}</div>
      <p class="muted" style="margin:0 0 14px">${usd((r.monthly / 730) * 24)} per hari, ${usd(r.yearly)} per tahun.</p>
      ${donut}${prov}
      <h3 style="margin:16px 0 6px">Kumulatif 12 bulan</h3>${growth}
      <div class="tbl-wrap" tabindex="0" style="margin-top:12px"><table><thead><tr><th scope="col">Sumber daya</th><th scope="col">Rincian</th><th scope="col" class="num">Per bulan</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.detail)}</td><td class="num">${usd(x.monthly)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="margin-top:10px">Region US East. Server sudah termasuk satu IPv4 publik.</p>
      <div class="tf-box"><h3>Template Terraform</h3><p class="muted">File <code>.tf</code> berisi server di atas dengan tipe, disk, dan jumlah yang sama. Kredensial tidak ikut disimpan.</p>
        <button class="btn primary" type="button" id="dlTf">Unduh template Terraform</button></div>`;
  }

  function calc() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!items.length) {
        lastCalc = null;
        $('#planOut').innerHTML = outHtml(null);
        return;
      }
      try {
        lastCalc = await api('POST', '/api/plan/calc', { items });
        $('#planOut').innerHTML = outHtml(lastCalc);
        C.bind($('#planOut'));
        $('#dlTf').addEventListener('click', (e) => terraformFile(e.currentTarget));
        // Biaya per kartu diperbarui di tempat supaya fokus di kolom isian tidak hilang.
        document.querySelectorAll('#planRows .res').forEach((el) => {
          const m = lastCalc.rows[Number(el.dataset.row)]?.monthly;
          el.querySelector('.res-c').innerHTML = m != null ? `${usd(m)}<small> per bulan</small>` : '';
        });
      } catch (e) {
        $('#planOut').innerHTML = `<p class="err" role="alert">${esc(e.message)}</p>`;
      }
    }, 180);
  }

  // Isi ulang pilihan tipe satu kartu setelah saringan berubah. Kalau tipe terpilih tidak lolos saringan,
  // tipe termurah yang lolos dipakai supaya biaya selalu sesuai dengan yang terlihat.
  function refreshTypes(i) {
    const it = items[i];
    const f = filterOf(i);
    const all = matches(it.provider, f);
    if (all.length && !all.some((t) => t.type === it.type)) it.type = all[0].type;
    const o = typeOptions(it, i);
    const card = $('#planRows').querySelector(`[data-row="${i}"]`);
    card.querySelector('[data-f="type"]').innerHTML = o.html;
    card.querySelector(`#fltN${i}`).textContent = countText(o, it.provider);
    headOf(i);
    calc();
  }
  function headOf(i) {
    const it = items[i];
    const t = cat.providers[it.provider].instances.find((x) => x.type === it.type);
    const card = $('#planRows').querySelector(`[data-row="${i}"]`);
    card.querySelector('.res-t small').textContent = t ? `${t.type}, ${t.vcpu} vCPU, ${t.memGiB} GiB, ${t.arch}` : 'Tipe belum dipilih';
  }

  function renderRows() {
    const box = $('#planRows');
    box.innerHTML = items.length ? items.map(rowHtml).join('') : '<div class="empty-box"><p class="muted">Belum ada server. Tambah server di bawah, atau pilih hasil dari tab Rekomendasi lalu tekan Pakai.</p></div>';
    box.querySelectorAll('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const i = Number(el.dataset.i);
        const f = el.dataset.f;
        if (f === 'type' && !el.value) return;
        items[i][f] = f === 'type' ? el.value : Number(el.value);
        if (f === 'type') headOf(i);
        calc();
      })
    );
    box.querySelectorAll('[data-prov]').forEach((g) =>
      g.addEventListener('change', (e) => {
        const i = Number(g.dataset.prov);
        items[i].provider = e.target.value;
        items[i].type = DEFAULT_TYPE[e.target.value];
        filt[i] = blankFilter();
        renderRows();
        calc();
        box.querySelector(`input[name="cProv${i}"]:checked`)?.focus();
      })
    );
    let qTimer = null;
    box.querySelectorAll('[data-flt]').forEach((el) => {
      const i = Number(el.dataset.i);
      const k = el.dataset.flt;
      const apply = () => { filterOf(i)[k] = k === 'q' || k === 'arch' ? el.value : Number(el.value); refreshTypes(i); };
      if (k === 'q') el.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(apply, 150); });
      else el.addEventListener('change', apply);
    });
    box.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.rm);
        items.splice(i, 1);
        filt.splice(i, 1);
        renderRows();
        calc();
      })
    );
  }

  // Unduh template Terraform (.tf) dari server, lalu tampilkan isinya di panel supaya bisa dibaca sebelum dipakai.
  async function terraformFile(btn) {
    if (!items.some((x) => x.kind === 'server')) return toast('Tambahkan minimal satu server dulu');
    const name = $('#planName').value.trim() || 'rencana';
    btn.disabled = true;
    try {
      const r = await fetch('/api/plan/terraform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, name }), credentials: 'same-origin' });
      const text = await r.text();
      if (!r.ok) throw new Error((() => { try { return JSON.parse(text).error; } catch { return `HTTP ${r.status}`; } })());
      const file = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'rencana.tf';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = file;
      a.click();
      URL.revokeObjectURL(a.href);
      $('#tfPreview').innerHTML = `<details open><summary>Isi ${esc(file)}</summary>${A.codeBox(text)}</details>`;
      toast(`${file} diunduh`);
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function savedHtml() {
    const list = cat.savedPlans;
    if (!list.length) return '<p class="muted">Belum ada rencana tersimpan.</p>';
    const max = Math.max(...list.map((p) => p.monthly), 1);
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Nama</th><th scope="col">Dibuat</th><th scope="col" class="num">Per bulan</th><th scope="col">Perbandingan</th><th scope="col">Aksi</th></tr></thead><tbody>${list
      .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(A.fmtTime(p.ts))}</td><td class="num">${usd(p.monthly)}</td><td style="min-width:140px"><div class="meter" style="max-width:none"><span style="width:${(p.monthly / max) * 100}%"></span></div></td><td><div class="row"><button class="btn small" type="button" data-load="${esc(p.id)}">Muat</button><button class="btn small danger" type="button" data-del="${esc(p.id)}">Hapus</button></div></td></tr>`)
      .join('')}</tbody></table></div>`;
  }

  function buildHtml() {
    return `<div class="plan">
        <div>
          <div class="plan-rows" id="planRows"></div>
          <div class="add-menu"><button class="btn" type="button" data-add="server">Tambah server</button></div>
          <form id="saveForm" class="row end save-row"><label>Nama rencana<input id="planName" maxlength="80" placeholder="Misalnya: Web toko tahap 1"></label><button class="btn primary" type="submit">Simpan</button></form>
        </div>
        <aside class="plan-out"><div id="planOut" aria-live="polite"></div><div id="tfPreview"></div></aside>
      </div>
      <section class="section" style="margin-top:28px"><h2>Rencana tersimpan</h2>${savedHtml()}</section>`;
  }

  function bindBuild(main) {
    renderRows();
    calc();
    main.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        if (items.length >= 50) return toast('Maksimum 50 server');
        const provider = items[items.length - 1]?.provider || 'aws';
        items.push({ kind: 'server', provider, type: DEFAULT_TYPE[provider], qty: 1, diskGB: 30 });
        renderRows();
        calc();
        $('#planRows').querySelector(`[data-row="${items.length - 1}"]`)?.scrollIntoView({ block: 'nearest' });
      })
    );
    $('#saveForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#planName').value.trim();
      if (!name) return toast('Beri nama rencana dulu');
      try {
        await api('POST', '/api/plan/save', { name, items });
        toast('Rencana disimpan');
        render(main);
      } catch (err) {
        toast(err.message);
      }
    });
    main.querySelectorAll('[data-load]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = cat.savedPlans.find((x) => x.id === b.dataset.load);
        if (!p) return;
        items = JSON.parse(JSON.stringify(p.items));
        filt = [];
        $('#planName').value = p.name;
        renderRows();
        calc();
      })
    );
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmInline(b, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('DELETE', `/api/plan/${b.dataset.del}`);
          toast('Rencana dihapus');
          render(main);
        })
      )
    );
  }

  async function render(main) {
    cat = await api('GET', '/api/plan/catalog');
    // Rencana lama bisa berisi data transfer atau object storage. Baris itu dibuang; rencana tanpa server tidak ditampilkan.
    cat.savedPlans = cat.savedPlans
      .map((p) => ({ ...p, items: p.items.filter((x) => x.kind === 'server' && x.provider && cat.providers[x.provider]) }))
      .filter((p) => p.items.length);
    items = items.filter((x) => x.kind === 'server');
    if (!items.length) { items = [{ kind: 'server', provider: 'aws', type: DEFAULT_TYPE.aws, qty: 1, diskGB: 30 }]; filt = []; }
    const tabs = `<nav class="tabs" aria-label="Mode planning"><a href="#" data-tab="recommend" ${tab === 'recommend' ? 'aria-current="page"' : ''}>Rekomendasi</a><a href="#" data-tab="build" ${tab === 'build' ? 'aria-current="page"' : ''}>Custom</a></nav>`;
    const body = tab === 'recommend' ? `${tabs}<div class="box">${recForm()}</div><div id="recOut"></div>` : `${tabs}${buildHtml()}`;
    main.innerHTML = pageHtml('Planning', '', body);
    main.querySelectorAll('[data-tab]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        tab = a.dataset.tab;
        render(main);
      })
    );
    if (tab === 'recommend') bindRec(main);
    else bindBuild(main);
  }

  window.Pages.plan = render;
})();
