'use strict';
// Halaman Ringkasan: forecast harian dan bulanan, tagihan asli per cloud, estimasi VPS, dan anggaran.
// Menimpa halaman Ringkasan lama lewat window.Pages.overview.
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml, confirmInline } = A;
  const C = window.Charts;
  const L = window.Logos;

  const RANGES = [{ d: 7, label: '7 hari' }, { d: 14, label: '14 hari' }, { d: 30, label: '30 hari' }];
  const state = { range: 30, view: 'harian', source: 'semua' };

  const dateLabel = (d) => d.slice(5);
  const isoToday = () => new Date().toISOString().slice(0, 10);

  // Forecast harian: dari rata-rata 7 hari terakhir tiap sumber yang punya data, dilanjutkan sampai akhir bulan.
  function forecastRows(o, days) {
    const today = isoToday();
    const per = o.cloud.sources;
    const rows = o.cloud.series.slice(-days).map((r) => ({ date: r.date, label: dateLabel(r.date), ...r }));
    const avgBilled = Object.values(per).filter((s) => s.kind === 'billed').reduce((a, s) => a + s.avg7, 0);
    const vpsPerDay = o.forecast.runRatePerHour * 24;
    const proj = [];
    const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
    const left = Math.max(0, end - new Date().getUTCDate());
    for (let i = 1; i <= left; i++) {
      const d = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
      const row = { date: d, label: dateLabel(d), proj: true, total: avgBilled + vpsPerDay };
      for (const s of Object.values(per)) row[s.id] = s.kind === 'billed' ? s.avg7 : 0;
      row.vps = vpsPerDay;
      proj.push(row);
    }
    return { rows, proj, today };
  }

  function sourceBadge(id) {
    return L.badge(id === 'vps' ? 'vps' : id, 'logo sm');
  }

  function sourcesStrip(o) {
    const st = o.cloudStatus;
    const per = o.cloud.sources;
    const item = (id) => {
      const s = st[id];
      const sum = per[id];
      const connected = s.configured;
      const head = `<span class="nm">${L.badge(id, 'logo')}${esc(s.label)}<span class="tag">${s.kind === 'billed' ? 'tagihan asli' : 'estimasi'}</span></span>`;
      const body = sum
        ? `<span class="am">${usd(sum.mtd)}</span><span class="st">bulan ini, data terbaru ${esc(sum.lastDate)}</span>`
        : connected
          ? `<span class="st">${s.kind === 'billed' ? 'Tersambung. Belum ada data: sinkronkan di Integrations.' : 'Menunggu laporan pertama dari agent.'}</span>`
          : `<span class="st"><span class="off-dot"></span> Belum tersambung. Klik untuk menyambungkan.</span>`;
      const href = id === 'vps' ? '#/integrations/vps' : `#/integrations/${id}`;
      return `<a class="source" href="${href}">${head}${body}</a>`;
    };
    return `<div class="sources">${['vps', 'aws', 'azure', 'gcp'].map(item).join('')}</div>`;
  }

  function chartSection(o) {
    const days = state.range;
    const fr = forecastRows(o, days);
    const series = [{ key: 'vps', label: 'VPS (estimasi)' }, { key: 'aws', label: 'AWS' }, { key: 'azure', label: 'Azure' }, { key: 'gcp', label: 'Google Cloud' }];
    const active = series.filter((s) => fr.rows.some((r) => r[s.key] > 0) || fr.proj.some((r) => r[s.key] > 0));
    const src = state.source;
    const use = src === 'semua' ? active : active.filter((s) => s.key === src);
    const all = [...fr.rows, ...fr.proj];
    if (!use.length || !all.some((r) => use.some((s) => r[s.key] > 0))) {
      return `<p class="chart-empty">Belum ada data biaya untuk ditampilkan. Hubungkan VPS atau cloud di Integrations, atau rencanakan biaya tanpa server di halaman <a href="#/plan">Perencanaan</a>.</p>`;
    }
    const cum = [];
    let run = 0;
    for (const r of all) {
      run += use.reduce((a, s) => a + (r[s.key] || 0), 0);
      cum.push({ date: r.date, proj: !!r.proj, v: run });
    }
    const label = `Biaya harian ${days} hari terakhir dan perkiraan sampai akhir bulan.`;
    const chart =
      state.view === 'harian'
        ? C.bars({ rows: all.map((r) => ({ ...r, label: r.label })), series: use.map((s, i) => ({ ...s, color: undefined })), label })
        : C.line({ rows: cum, label: `Biaya kumulatif bulan berjalan dan perkiraannya. ${label}`, refLine: o.budget?.amount || 0, refLabel: o.budget?.amount ? `budget ${usd(o.budget.amount)}` : '' });
    const rows = all
      .map((r) => `<tr><td>${esc(r.date)}</td><td>${r.proj ? 'perkiraan' : 'aktual'}</td>${use.map((s) => `<td class="num">${usd(r[s.key] || 0)}</td>`).join('')}<td class="num">${usd(use.reduce((a, s) => a + (r[s.key] || 0), 0))}</td></tr>`)
      .join('');
    const legend = use.map((s, i) => `<span><i style="background:var(--s${(i % 4) + 1})"></i>${esc(s.label)}</span>`).join('');
    return `${chart}
      <div class="legend">${legend}${fr.proj.length ? '<span>Batang dan garis putus-putus: perkiraan dari rata-rata 7 hari terakhir</span>' : ''}</div>
      <details class="data"><summary>Lihat data dalam tabel</summary><div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">Jenis</th>${use.map((s) => `<th scope="col" class="num">${esc(s.label)}</th>`).join('')}<th scope="col" class="num">Total</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  }

  function breakdown(o) {
    const per = Object.values(o.cloud.sources);
    if (!per.length) return '';
    const merged = {};
    for (const s of per) for (const x of s.services) merged[`${s.label}: ${x.name}`] = (merged[`${s.label}: ${x.name}`] || 0) + x.amount;
    const sorted = Object.entries(merged).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5).map(([label, value]) => ({ label, value }));
    const rest = sorted.slice(5).reduce((a, [, v]) => a + v, 0);
    if (rest > 0) top.push({ label: 'Lainnya', value: rest });
    if (!top.some((t) => t.value > 0)) return '';
    return `<section class="section"><h2>Rincian biaya per layanan, ${state.range} hari terakhir</h2>${C.donut({ slices: top, label: 'Porsi biaya per layanan', center: { top: usd(top.reduce((a, t) => a + t.value, 0)), bottom: 'total' } })}</section>`;
  }

  function budgetCard(o) {
    const b = o.balance;
    const used = b.credit > 0 ? Math.min(100, (b.spent / b.credit) * 100) : 0;
    return `<section class="section" id="budget"><h2>Anggaran</h2>
      <p class="muted" style="max-width:640px">Anggaran adalah uang yang kamu sediakan untuk biaya server, pribadi atau usaha. Angkanya kamu atur sendiri dan bisa ditambah, dikurangi, atau ditetapkan ulang kapan saja. Ini bukan saldo akun AWS, Azure, atau Google Cloud. Yang terpakai dihitung dari estimasi biaya VPS yang terhubung.</p>
      <div class="meter" role="img" aria-label="${used.toFixed(0)} persen anggaran terpakai"><span style="width:${used}%"></span></div>
      <p class="muted" style="margin:6px 0 12px">Terpakai ${usd(b.spent)} dari ${usd(b.credit)}. Sisa ${usd(b.remaining)}.</p>
      <form id="budgetForm" class="row end">
        <label>Jumlah (USD)<input type="number" id="bAmt" min="0" step="any" value="100" required style="width:150px"></label>
        <div class="seg-ctl" role="group" aria-label="Jenis perubahan anggaran">
          <button type="button" data-mode="add" aria-pressed="true">Tambah</button>
          <button type="button" data-mode="subtract" aria-pressed="false">Kurangi</button>
          <button type="button" data-mode="set" aria-pressed="false">Tetapkan total</button>
        </div>
        <button class="btn primary" type="submit">Terapkan</button>
      </form></section>`;
  }

  function headline(o) {
    const fc = o.forecast.forecast;
    const budget = o.budget?.amount || 0;
    const billed = o.cloud.billedForecast;
    const pct = budget ? ((fc + billed) / budget) * 100 : 0;
    const total = fc + billed;
    const meter = budget
      ? `<div class="meter ${pct > 100 ? 'over' : ''}" role="img" aria-label="Forecast ${pct.toFixed(0)} persen dari budget"><span style="width:${Math.min(100, pct)}%"></span></div>
         <p class="sub">${pct > 100 ? `Melebihi budget ${usd(budget)} sekitar ${usd(total - budget)}.` : `${pct.toFixed(0)}% dari budget bulanan ${usd(budget)}.`} Sumber budget: ${esc(o.budget.source)}.</p>`
      : '<p class="sub">Budget bulanan belum diatur. Isi di Automations atau lewat baris <code>budget: 30</code> di Context files.</p>';
    const parts = [];
    if (fc > 0) parts.push(`estimasi VPS ${usd(fc)}`);
    if (billed > 0) parts.push(`tagihan cloud ${usd(billed)}`);
    return `<div class="summary">
      <div class="focus">
        <div class="label">Perkiraan biaya sampai akhir bulan</div>
        <div class="big">${usd(total)}</div>
        ${parts.length ? `<p class="sub" style="margin-top:0">Terdiri dari ${parts.join(' dan ')}.</p>` : ''}
        ${meter}
      </div>
      <dl class="facts">
        <div><dt>Terpakai bulan ${esc(o.mtd.month)}</dt><dd>${usd(o.mtd.total + o.cloud.billedMtd)}<small>${o.cloud.billedMtd > 0 ? `termasuk tagihan cloud ${usd(o.cloud.billedMtd)}` : 'estimasi VPS'}</small></dd></div>
        <div><dt>Run rate VPS</dt><dd>${usd(o.forecast.runRatePerHour * 24)}/hari<small>${usd(o.forecast.runRatePerHour, 4)}/jam</small></dd></div>
        <div><dt>Sisa anggaran</dt><dd>${usd(o.balance.remaining)}<small>dari ${usd(o.balance.credit)}</small></dd></div>
      </dl>
    </div>`;
  }

  async function render(main) {
    const o = await A.refreshBalance();
    if (!o) throw new Error('Data ringkasan tidak bisa diambil');
    const controls = `<div class="toolbar">
        <div class="seg-ctl" role="group" aria-label="Rentang waktu">${RANGES.map((r) => `<button type="button" data-range="${r.d}" aria-pressed="${state.range === r.d}">${r.label}</button>`).join('')}</div>
        <div class="seg-ctl" role="group" aria-label="Tampilan grafik"><button type="button" data-view="harian" aria-pressed="${state.view === 'harian'}">Harian</button><button type="button" data-view="kumulatif" aria-pressed="${state.view === 'kumulatif'}">Kumulatif</button></div>
        <label class="row" style="gap:6px">Sumber<select id="srcSel" style="width:auto"><option value="semua">Semua</option>${['vps', 'aws', 'azure', 'gcp'].map((id) => `<option value="${id}" ${state.source === id ? 'selected' : ''}>${esc(o.cloudStatus[id].label)}</option>`).join('')}</select></label>
      </div>`;
    const body = `${headline(o)}${sourcesStrip(o)}
      <section class="section"><h2>Biaya harian dan perkiraan sampai akhir bulan</h2>${controls}<div id="chartHost">${chartSection(o)}</div></section>
      ${breakdown(o)}
      <section class="section"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">VPS</h2><a href="#/integrations">Kelola di Integrations</a></div>
        ${o.vps.length ? window.App.vpsTable(o.vps) : '<p class="muted">Belum ada VPS. Hubungkan server lewat <a href="#/integrations">Integrations</a>, atau coba <a href="#/plan">Perencanaan</a> untuk menghitung biaya tanpa server.</p>'}</section>
      <section class="section"><h2>Anomali, 30 hari terakhir</h2>
        ${o.anomalies.length
          ? `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">VPS</th><th scope="col">Service</th><th scope="col" class="num">Perkiraan</th><th scope="col" class="num">Aktual</th><th scope="col" class="num">Dampak</th></tr></thead><tbody>${o.anomalies
              .map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.vpsName)}</td><td>${esc(a.service)}</td><td class="num">${usd(a.expected)}</td><td class="num">${usd(a.actual)}</td><td class="num">${usd(a.impact)}</td></tr>`)
              .join('')}</tbody></table></div>`
          : '<p class="muted">Tidak ada lonjakan biaya yang melewati 1,5x baseline 14 hari.</p>'}
      </section>
      ${budgetCard(o)}`;
    main.innerHTML = pageHtml('Ringkasan', `<span class="muted">Harga estimasi VPS: ${esc(o.region.name)}</span>`, body);
    C.bind(main);

    const redraw = () => {
      $('#chartHost').innerHTML = chartSection(o);
      C.bind($('#chartHost'));
      main.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range)));
      main.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    };
    main.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { state.range = Number(b.dataset.range); redraw(); }));
    main.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; redraw(); }));
    $('#srcSel').addEventListener('change', (e) => { state.source = e.target.value; redraw(); });

    let mode = 'add';
    main.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        main.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      })
    );
    $('#budgetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/settings/topup', { amount: Number($('#bAmt').value), mode });
        toast(mode === 'set' ? 'Total anggaran ditetapkan' : mode === 'subtract' ? 'Anggaran dikurangi' : 'Anggaran ditambah');
        render(main);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  window.Pages.overview = render;
})();
