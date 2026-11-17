'use strict';
// Planning: hitung biaya server sebelum membuat apa pun, tanpa akun cloud dan tanpa mengeluarkan uang.
//   1. Rekomendasi: isi budget dan kebutuhan, sistem memilih spesifikasi dari aturan tetap dan daftar harga.
//   2. Susun sendiri: daftar sumber daya di AWS, Azure, atau Google Cloud, lalu lihat biaya per bulan dan 12 bulan.
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
  const form = { budget: 25, workload: 'webapp', visits: 20000, storageGB: 10, ha: false, growth: false, providers: [...IDS], arch: 'any' };

  const DEFAULT_TYPE = { aws: 't3a.small', azure: 'Standard_B1ms', gcp: 'e2-small' };

  // ---------- rekomendasi ----------
  function recForm() {
    const wl = Object.entries(cat.workloads).map(([k, v]) => `<option value="${k}" ${form.workload === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    const prov = IDS.map((id) => `<label class="chk">${L.badge(id, 'logo xs')}<input type="checkbox" data-prov="${id}" ${form.providers.includes(id) ? 'checked' : ''}> ${esc(cat.providers[id].label)}</label>`).join('');
    return `<form id="recForm" class="rec-form">
      <label>Budget per bulan (USD)<input type="number" id="rBudget" min="1" step="any" value="${esc(form.budget)}" required></label>
      <label>Mau bikin apa<select id="rWork">${wl}</select></label>
      <label>Perkiraan kunjungan per bulan<input type="number" id="rVisits" min="0" step="1000" value="${esc(form.visits)}"></label>
      <label>Data yang disimpan (GB)<input type="number" id="rStore" min="0" step="1" value="${esc(form.storageGB)}"></label>
      <label>Arsitektur CPU<select id="rArch"><option value="any" ${form.arch === 'any' ? 'selected' : ''}>Bebas</option><option value="x86_64" ${form.arch === 'x86_64' ? 'selected' : ''}>x86_64 (Intel/AMD)</option><option value="arm64" ${form.arch === 'arm64' ? 'selected' : ''}>arm64 (lebih hemat, cek kompatibilitas)</option></select></label>
      <fieldset class="span2"><legend>Platform yang dipertimbangkan</legend><div class="row">${prov}</div></fieldset>
      <fieldset class="span2"><legend>Kebutuhan tambahan</legend><div class="row">
        <label class="chk"><input type="checkbox" id="rHa" ${form.ha ? 'checked' : ''}> Tetap jalan kalau satu server mati (2 server dan load balancer)</label>
        <label class="chk"><input type="checkbox" id="rGrow" ${form.growth ? 'checked' : ''}> Sisakan ruang untuk tumbuh</label>
      </div></fieldset>
      <div class="span2 row"><button class="btn primary" type="submit">Cari spesifikasi</button><span class="muted" id="rNote">${esc(cat.workloads[form.workload].note)}</span></div>
    </form>`;
  }

  function recResult(r) {
    const req = r.requirement;
    const need = `<div class="stats"><div class="stat"><div class="sv">${req.vcpu} vCPU</div><div class="sl">kebutuhan CPU per server</div></div><div class="stat"><div class="sv">${req.mem} GiB</div><div class="sl">kebutuhan RAM per server</div></div><div class="stat"><div class="sv">${req.diskGB} GB</div><div class="sl">disk per server</div></div><div class="stat"><div class="sv">${req.egressGB} GB</div><div class="sl">data keluar per bulan</div></div></div>`;
    const best = r.best
      ? `<div class="pick">${L.badge(r.best.provider, 'logo lg')}<div><div class="label muted">Disarankan</div><div class="pick-name">${esc(r.best.label)} <code>${esc(r.best.type)}</code>${r.best.count > 1 ? ` x ${r.best.count}` : ''}</div>
          <div class="big">${usd(r.best.monthly)}<small> per bulan</small></div><p class="muted" style="margin:0">${esc(r.best.region.name)}. Sisa budget ${usd(r.best.left)}.</p></div></div>
         <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
         <div class="row"><button class="btn" type="button" data-use="best">Pakai di Susun sendiri</button></div>`
      : `<div class="note"><b>Budget ${usd(r.budget)} belum cukup.</b> Pilihan terdekat butuh ${usd(r.options[0]?.monthly || 0)} per bulan, kurang ${usd(r.cheapestGap || 0)}. Turunkan kebutuhan atau naikkan budget.</div>`;
    const chart = C.hbars({ rows: r.options.slice(0, 8).map((o) => ({ label: `${o.label} ${o.type}`, sub: `${o.vcpu} vCPU, ${o.memGiB} GiB${o.tier === 'cadangan' ? ', ruang tumbuh' : ''}`, value: o.monthly, color: COLOR[o.provider] })), label: 'Perbandingan biaya per bulan terhadap budget', ref: r.budget, refLabel: `budget ${usd(r.budget)}` });
    const table = `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Platform</th><th scope="col">Tipe</th><th scope="col">Spesifikasi</th><th scope="col" class="num">Server</th><th scope="col" class="num">Disk dan IP</th><th scope="col" class="num">Transfer dan LB</th><th scope="col" class="num">Per bulan</th><th scope="col">Budget</th><th scope="col"><span class="sr-only">Aksi</span></th></tr></thead><tbody>${r.options
      .map((o, i) => `<tr><td><span class="cell-logo">${L.badge(o.provider, 'logo xs')}${esc(o.label)}</span></td><td><code>${esc(o.type)}</code>${o.count > 1 ? ` x ${o.count}` : ''}</td><td>${o.vcpu} vCPU, ${o.memGiB} GiB, ${esc(o.arch)}</td><td class="num">${usd(o.parts.server)}</td><td class="num">${usd(o.parts.disk + o.parts.ip)}</td><td class="num">${usd(o.parts.egress + o.parts.lb)}</td><td class="num"><b>${usd(o.monthly)}</b></td><td>${o.fits ? '<span class="s-ok">Sesuai budget</span>' : '<span class="s-alert">Melebihi budget</span>'}</td><td><button class="btn small" type="button" data-use="${i}">Pakai</button></td></tr>`)
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
          tab = 'build';
          render(main);
          toast('Dimuat ke Susun sendiri');
        })
      );
    } catch (e) {
      out.innerHTML = `<p class="err" role="alert">${esc(e.message)}</p>`;
    }
  }

  function bindRec(main) {
    const read = () => {
      form.budget = Number($('#rBudget').value);
      form.workload = $('#rWork').value;
      form.visits = Number($('#rVisits').value) || 0;
      form.storageGB = Number($('#rStore').value) || 0;
      form.arch = $('#rArch').value;
      form.ha = $('#rHa').checked;
      form.growth = $('#rGrow').checked;
      form.providers = IDS.filter((id) => main.querySelector(`[data-prov="${id}"]`).checked);
      $('#rNote').textContent = cat.workloads[form.workload].note;
    };
    $('#recForm').addEventListener('change', read);
    $('#recForm').addEventListener('submit', (e) => {
      e.preventDefault();
      read();
      if (!form.providers.length) return toast('Pilih minimal satu platform');
      runRec(main);
    });
    runRec(main);
  }

  // ---------- susun sendiri ----------
  const typeOptions = (provider, sel) => {
    const list = cat.providers[provider].instances;
    const groups = { x86_64: 'x86_64', arm64: 'arm64' };
    return Object.entries(groups)
      .map(([arch, label]) => {
        const opts = list.filter((i) => i.arch === arch);
        return opts.length ? `<optgroup label="${label}">${opts.map((i) => `<option value="${esc(i.type)}" ${i.type === sel ? 'selected' : ''}>${esc(i.type)}: ${i.vcpu} vCPU, ${i.memGiB} GiB, ${usd(i.hourly, 4)}/jam</option>`).join('')}</optgroup>` : '';
      })
      .join('');
  };
  const provSelect = (it, i) => `<label>Platform<select data-f="provider" data-i="${i}">${IDS.map((id) => `<option value="${id}" ${it.provider === id ? 'selected' : ''}>${esc(cat.providers[id].label)}</option>`).join('')}</select></label>`;

  function rowHtml(it, i) {
    const k = cat.kinds[it.kind];
    const main = it.kind === 'server'
      ? `<label>Tipe server<select data-f="type" data-i="${i}">${typeOptions(it.provider, it.type)}</select></label><label>Disk (GB)<input type="number" min="0" step="1" data-f="diskGB" data-i="${i}" value="${esc(it.diskGB ?? 30)}"></label>`
      : `<label>Jenis<input value="${esc(k.label)}" disabled></label><span></span>`;
    return `<div class="plan-row" data-row="${i}">${provSelect(it, i)}${main}
      <label>Jumlah (${esc(k.unit)})<input type="number" min="0" step="any" data-f="qty" data-i="${i}" value="${esc(it.qty)}"></label>
      <button class="btn small danger" type="button" data-rm="${i}" aria-label="Hapus baris ${esc(k.label)}">Hapus</button></div>`;
  }

  function outHtml(r) {
    if (!r) return '<p class="muted">Tambahkan sumber daya untuk melihat perkiraan biaya.</p>';
    const byProv = {};
    for (const x of r.rows) byProv[x.provider] = (byProv[x.provider] || 0) + x.monthly;
    const donut = C.donut({ slices: r.rows.filter((x) => x.monthly > 0).map((x) => ({ label: `${x.label} (${x.detail})`, value: x.monthly })), label: 'Porsi biaya bulanan per sumber daya', center: { top: usd(r.monthly), bottom: 'per bulan' }, size: 140 });
    const prov = Object.keys(byProv).length > 1 ? `<h3 style="margin:16px 0 6px">Per platform</h3>${C.hbars({ rows: Object.entries(byProv).map(([id, v]) => ({ label: cat.providers[id].label, value: v, color: COLOR[id] })), label: 'Biaya per platform' })}` : '';
    const growth = C.line({ rows: r.growth.map((g) => ({ date: `Bulan ${g.month}`, v: g.cumulative })), label: 'Biaya kumulatif 12 bulan', height: 160 });
    return `<div class="label muted">Perkiraan biaya per bulan</div>
      <div class="big">${usd(r.monthly)}</div>
      <p class="muted" style="margin:0 0 14px">${usd((r.monthly / 730) * 24)} per hari, ${usd(r.yearly)} per tahun.</p>
      ${donut}${prov}
      <h3 style="margin:16px 0 6px">Kumulatif 12 bulan</h3>${growth}
      <div class="tbl-wrap" tabindex="0" style="margin-top:12px"><table><thead><tr><th scope="col">Sumber daya</th><th scope="col">Rincian</th><th scope="col" class="num">Per bulan</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.detail)}</td><td class="num">${usd(x.monthly)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="margin-top:10px">Region US East. Server sudah termasuk satu IPv4 publik.</p>`;
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
      } catch (e) {
        $('#planOut').innerHTML = `<p class="err" role="alert">${esc(e.message)}</p>`;
      }
    }, 180);
  }

  function renderRows() {
    $('#planRows').innerHTML = items.length ? items.map(rowHtml).join('') : '<p class="muted">Belum ada baris. Tambah sumber daya di bawah, atau ambil dari tab Rekomendasi.</p>';
    $('#planRows').querySelectorAll('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const it = items[Number(el.dataset.i)];
        const f = el.dataset.f;
        it[f] = f === 'type' || f === 'provider' ? el.value : Number(el.value);
        if (f === 'provider' && it.kind === 'server') {
          it.type = DEFAULT_TYPE[it.provider];
          renderRows();
        }
        calc();
      })
    );
    $('#planRows').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.rm), 1); renderRows(); calc(); }));
  }

  function csv() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['Sumber daya,Rincian,Per bulan (USD)', ...lastCalc.rows.map((r) => `${q(r.label)},${q(r.detail)},${r.monthly.toFixed(2)}`), `Total,,${lastCalc.monthly.toFixed(2)}`];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    a.download = 'planning-biaya.csv';
    a.click();
    URL.revokeObjectURL(a.href);
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
    const add = Object.entries(cat.kinds).map(([k, v]) => `<button class="btn small" type="button" data-add="${k}">${esc(v.label)}</button>`).join('');
    return `<div class="plan">
        <div>
          <div class="plan-rows" id="planRows"></div>
          <div class="add-menu"><span class="muted" style="align-self:center">Tambah:</span>${add}</div>
          <form id="saveForm" class="row end" style="margin-top:18px"><label>Nama rencana<input id="planName" maxlength="80" placeholder="Misalnya: Web toko tahap 1" style="width:240px"></label><button class="btn primary" type="submit">Simpan</button><button class="btn" type="button" id="dlPlan">Unduh CSV</button></form>
        </div>
        <aside class="plan-out" id="planOut" aria-live="polite"></aside>
      </div>
      <section class="section" style="margin-top:28px"><h2>Rencana tersimpan</h2>${savedHtml()}</section>`;
  }

  function bindBuild(main) {
    renderRows();
    calc();
    main.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        if (items.length >= 50) return toast('Maksimum 50 baris');
        const kind = b.dataset.add;
        const provider = items[items.length - 1]?.provider || 'aws';
        items.push(kind === 'server' ? { kind, provider, type: DEFAULT_TYPE[provider], qty: 1, diskGB: 30 } : { kind, provider, qty: kind === 'egress' ? 100 : kind === 'storage' ? 50 : 1 });
        renderRows();
        calc();
      })
    );
    $('#dlPlan').addEventListener('click', () => (lastCalc ? csv() : toast('Belum ada rencana untuk diunduh')));
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
    // Rencana dari versi lama memakai format berbeda dan tidak bisa dihitung lagi.
    cat.savedPlans = cat.savedPlans.filter((p) => p.items.every((x) => cat.kinds[x.kind] && x.provider));
    if (!items.length) items = [{ kind: 'server', provider: 'aws', type: 't3a.small', qty: 1, diskGB: 30 }, { kind: 'egress', provider: 'aws', qty: 100 }];
    const tabs = `<nav class="tabs" aria-label="Mode planning"><a href="#" data-tab="recommend" ${tab === 'recommend' ? 'aria-current="page"' : ''}>Rekomendasi</a><a href="#" data-tab="build" ${tab === 'build' ? 'aria-current="page"' : ''}>Susun sendiri</a></nav>`;
    const intro = '<p class="muted" style="max-width:720px">Hitung biaya server sebelum membuatnya. Tidak butuh akun cloud dan tidak mengeluarkan uang. Hasilnya tidak mengubah budget atau data server.</p>';
    const body = tab === 'recommend' ? `${tabs}${intro}<div class="box">${recForm()}</div><div id="recOut"></div>` : `${tabs}${intro}${buildHtml()}`;
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
