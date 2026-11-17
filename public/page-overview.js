'use strict';
// Dashboard: server terdaftar di AWS, Azure, dan Google Cloud, dalam satu halaman.
// Beberapa grafik tampil sekaligus (harian, kumulatif vs budget, porsi platform, server terbesar),
// diikuti tabel penggunaan per platform, daftar server, peluang hemat, dan budget.
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml } = A;
  const C = window.Charts;
  const L = window.Logos;

  const IDS = ['aws', 'azure', 'gcp'];
  const COLOR = { aws: 'var(--p-aws)', azure: 'var(--p-azure)', gcp: 'var(--p-gcp)' };
  const STATE = { running: 'running', stopped: 'stopped' };
  const state = { range: 30, filter: 'all' };
  const short = (d) => d.slice(5);

  function headline(o) {
    const b = o.budget;
    const t = o.totals;
    const pct = b.amount > 0 ? (t.forecast / b.amount) * 100 : 0;
    const meter = b.amount > 0
      ? `<div class="meter ${b.over ? 'over' : ''}" role="img" aria-label="Perkiraan ${pct.toFixed(0)} persen dari budget"><span style="width:${Math.min(100, pct)}%"></span></div>
         <p class="sub">${b.over ? `Lebih ${usd(t.forecast - b.amount)} dari budget ${usd(b.amount)}.` : `${pct.toFixed(0)}% dari budget ${usd(b.amount)}.`}</p>`
      : '<p class="sub">Budget belum diatur. Atur di bagian Budget di bawah.</p>';
    return `<div class="summary">
      <div class="focus">
        <div class="label">Perkiraan biaya server sampai akhir bulan</div>
        <div class="big">${usd(t.forecast)}</div>
        ${meter}
      </div>
      <dl class="facts">
        <div><dt>Terpakai bulan ini</dt><dd>${usd(t.mtd)}</dd></div>
        <div><dt>Rata-rata per hari</dt><dd>${usd(t.perDay)}<small>${o.daysLeft} hari lagi sampai akhir bulan</small></dd></div>
        <div><dt>Server running</dt><dd>${t.running} dari ${t.servers}</dd></div>
        <div><dt>Budget tersisa</dt><dd>${usd(b.remaining)}<small>dari ${usd(b.amount)} per bulan</small></dd></div>
      </dl>
    </div>`;
  }

  function platformCards(o) {
    return `<div class="sources">${IDS.map((id) => {
      const p = o.platforms[id];
      const head = `<span class="nm">${L.badge(id, 'logo')}${esc(p.label)}${p.configured ? `<span class="tag">${p.basis}</span>` : ''}</span>`;
      if (!p.configured) return `<a class="source off" href="#/integrations/${id}">${head}<span class="st"><span class="off-dot"></span> Belum tersambung. Sambungkan akun.</span></a>`;
      return `<a class="source" href="#/integrations/${id}">${head}<span class="am">${usd(p.forecastMonth)}</span><span class="st">perkiraan akhir bulan. ${p.running} running, ${p.stopped} stopped.</span></a>`;
    }).join('')}</div>`;
  }

  // Grafik 1: biaya harian per platform dan totalnya. Garis putus-putus setelah "hari ini" adalah perkiraan.
  function dailyChart(o) {
    const hist = o.series.slice(-state.range).map((r) => ({ ...r, label: short(r.date) }));
    const proj = o.projection.map((r) => ({ ...r, label: short(r.date) }));
    const rows = [...hist, ...proj];
    const active = IDS.filter((id) => rows.some((r) => r[id] > 0));
    if (!active.length) return '<p class="chart-empty">Belum ada biaya harian.</p>';
    const series = active.map((id) => ({ key: id, label: o.platforms[id].label, color: COLOR[id], area: active.length === 1 }));
    if (active.length > 1) series.unshift({ key: 'total', label: 'Total', color: 'var(--text)', bold: true, area: false });
    const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
    return `${C.lines({ rows, series, label: `Biaya harian ${state.range} hari terakhir dan perkiraan sampai akhir bulan`, height: 230 })}
      <div class="lc-legend">${legend}${proj.length ? '<span><i class="dash"></i>Perkiraan</span>' : ''}</div>`;
  }

  // Grafik 2: kumulatif bulan berjalan dan perkiraannya terhadap budget.
  function cumulativeChart(o) {
    const month = o.month;
    const rows = [];
    let acc = 0;
    for (const r of o.series) {
      if (!r.date.startsWith(month)) continue;
      acc += r.total;
      rows.push({ date: short(r.date), v: acc });
    }
    // Titik terakhir riwayat disamakan dengan biaya bulan berjalan yang dihitung server.
    if (rows.length) rows[rows.length - 1].v = o.totals.mtd;
    acc = o.totals.mtd;
    for (const r of o.projection) {
      acc += r.total;
      rows.push({ date: short(r.date), v: acc, proj: true });
    }
    if (rows.length < 2) return '<p class="chart-empty">Belum cukup data bulan ini.</p>';
    return `${C.line({ rows, label: 'Biaya kumulatif bulan ini dan perkiraannya dibanding budget', height: 200, refLine: o.budget.amount || 0, refLabel: o.budget.amount ? `Budget ${usd(o.budget.amount)}` : '', valueLabel: 'Total sejak awal bulan' })}
      <div class="lc-legend"><span><i style="background:var(--s1)"></i>Terpakai</span><span><i class="dash"></i>Perkiraan</span>${o.budget.amount ? '<span><i style="background:var(--bad)"></i>Budget</span>' : ''}</div>`;
  }

  // Grafik 3: porsi perkiraan akhir bulan per platform.
  function shareChart(o) {
    const slices = IDS.map((id) => ({ label: o.platforms[id].label, value: o.platforms[id].forecastMonth, color: COLOR[id] })).filter((s) => s.value > 0);
    if (!slices.length) return '<p class="chart-empty">Belum ada biaya.</p>';
    return C.donut({ slices, label: 'Porsi perkiraan akhir bulan per platform', size: 140, center: { top: usd(o.totals.forecast), bottom: 'akhir bulan' } });
  }

  // Grafik 4: server dengan estimasi biaya bulanan terbesar.
  function topChart(o) {
    const top = [...o.servers].sort((a, b) => b.monthly - a.monthly).slice(0, 6);
    if (!top.length) return '<p class="chart-empty">Belum ada server.</p>';
    return C.hbars({ rows: top.map((s) => ({ label: s.name, sub: `${o.platforms[s.provider].label}, ${s.type}`, value: s.monthly, color: COLOR[s.provider] })), label: 'Server dengan estimasi biaya bulanan terbesar' });
  }

  function usageTable(o) {
    const rows = IDS.map((id) => {
      const p = o.platforms[id];
      const list = o.servers.filter((s) => s.provider === id);
      const run = list.filter((s) => s.state === 'running');
      const vcpu = run.reduce((a, s) => a + (s.vcpu || 0), 0);
      const mem = run.reduce((a, s) => a + (s.memGiB || 0), 0);
      const disk = list.reduce((a, s) => a + (s.diskGB || 0), 0);
      return { id, p, list, run, vcpu, mem, disk };
    });
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const tr = (r) => `<tr><th scope="row"><span class="cell-logo">${L.badge(r.id, 'logo xs')}${esc(r.p.label)}</span></th>
      <td class="num">${r.run.length} / ${r.list.length}</td><td class="num">${r.vcpu}</td><td class="num">${r.mem.toFixed(1)} GiB</td><td class="num">${r.disk} GB</td>
      <td class="num">${usd(r.p.mtd)}</td><td class="num">${usd(r.p.perDay)}</td><td class="num">${usd(r.p.forecastMonth)}</td>
      <td>${r.p.configured ? (r.p.billed ? 'Bills' : 'Estimasi') : '<span class="muted">Belum tersambung</span>'}</td></tr>`;
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Platform</th><th scope="col" class="num">Running / total</th><th scope="col" class="num">vCPU aktif</th><th scope="col" class="num">RAM aktif</th><th scope="col" class="num">Disk</th><th scope="col" class="num">Terpakai</th><th scope="col" class="num">Per hari</th><th scope="col" class="num">Akhir bulan</th><th scope="col">Dasar angka</th></tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td class="num">${o.totals.running} / ${o.servers.length}</td><td class="num">${sum('vcpu')}</td><td class="num">${sum('mem').toFixed(1)} GiB</td><td class="num">${sum('disk')} GB</td><td class="num">${usd(o.totals.mtd)}</td><td class="num">${usd(o.totals.perDay)}</td><td class="num">${usd(o.totals.forecast)}</td><td></td></tr></tfoot></table></div>`;
  }

  function serverTable(o) {
    const list = o.servers.filter((s) => state.filter === 'all' || s.provider === state.filter).sort((a, b) => b.monthly - a.monthly);
    if (!list.length) return '<p class="muted">Tidak ada server untuk filter ini.</p>';
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Server</th><th scope="col">Platform</th><th scope="col">Lokasi</th><th scope="col">Tipe</th><th scope="col">Spesifikasi</th><th scope="col">Status</th><th scope="col" class="num">Per jam</th><th scope="col" class="num">Per bulan</th></tr></thead><tbody>${list
      .map((s) => `<tr><td>${esc(s.name)}</td><td><span class="cell-logo">${L.badge(s.provider, 'logo xs')}${esc(o.platforms[s.provider].label)}</span></td><td>${esc(s.location)}</td><td><code>${esc(s.type)}</code>${s.known ? '' : '<br><span class="muted">tipe tidak ada di daftar harga</span>'}</td>
        <td>${s.vcpu ? `${s.vcpu} vCPU, ${s.memGiB} GiB, ` : ''}${s.diskGB} GB disk</td><td><span class="status s-${esc(s.state)}">${esc(STATE[s.state] || s.state)}</span></td>
        <td class="num">${s.hourly ? usd(s.hourly, 4) : '-'}</td><td class="num">${usd(s.monthly)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  }

  function savingsSection(o) {
    if (!o.savings.length) return '';
    const total = o.savings.reduce((a, s) => a + s.monthly, 0);
    return `<section class="section"><h2>Peluang hemat, sekitar ${usd(total)} per bulan</h2>
      <div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Server</th><th scope="col">Platform</th><th scope="col">Saran</th><th scope="col" class="num">Hemat per bulan</th></tr></thead><tbody>${o.savings
        .map((s) => `<tr><td>${esc(s.server.name)}</td><td>${esc(o.platforms[s.server.provider].label)}</td><td>${esc(s.text)}</td><td class="num">${usd(s.monthly)}</td></tr>`)
        .join('')}</tbody></table></div></section>`;
  }

  function anomalySection(o) {
    if (!o.anomalies.length) return '';
    return `<section class="section"><h2>Lonjakan bills, 30 hari terakhir</h2><div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">Platform</th><th scope="col">Layanan terbesar</th><th scope="col" class="num">Normal</th><th scope="col" class="num">Aktual</th></tr></thead><tbody>${o.anomalies
      .map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.label)}</td><td>${esc(a.service)}</td><td class="num">${usd(a.expected)}</td><td class="num">${usd(a.actual)}</td></tr>`)
      .join('')}</tbody></table></div></section>`;
  }

  function budgetSection(o) {
    const b = o.budget;
    return `<section class="section" id="budget"><h2>Budget bulanan</h2>
      <p class="muted" style="max-width:640px">Uang yang kamu sediakan untuk biaya server setiap bulan, pribadi atau usaha. Bukan saldo akun cloud. Ubah kapan saja.</p>
      <p style="margin:0 0 12px">Budget <b>${usd(b.amount)}</b> per bulan. Terpakai ${usd(b.used)}, sisa ${usd(b.remaining)}.</p>
      <form id="budgetForm" class="row end">
        <label>Jumlah (USD)<input type="number" id="bAmt" min="0" step="any" value="10" required style="width:150px"></label>
        <div class="seg-ctl" role="group" aria-label="Jenis perubahan budget">
          <button type="button" data-mode="add" aria-pressed="true">Tambah</button>
          <button type="button" data-mode="subtract" aria-pressed="false">Kurangi</button>
          <button type="button" data-mode="set" aria-pressed="false">Tetapkan</button>
        </div>
        <button class="btn primary" type="submit">Terapkan</button>
      </form></section>`;
  }

  function onboarding() {
    return `<section class="box onboard"><h2>Sambungkan akun cloud</h2>
      <p class="muted">Dashboard membaca daftar server dan bills dari akun cloud memakai kredensial read-only. Belum punya server? Hitung dulu biayanya di Planning.</p>
      <div class="row">${IDS.map((id) => `<a class="btn" href="#/integrations/${id}">${L.badge(id, 'logo xs')}${{ aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud' }[id]}</a>`).join('')}<a class="btn primary" href="#/plan">Buka Planning</a></div></section>`;
  }

  async function render(main) {
    const o = await A.refreshBalance();
    if (!o) throw new Error('Data dashboard tidak bisa diambil');
    const live = `<span class="muted live">Diperbarui ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>`;
    if (!o.hasData) {
      main.innerHTML = pageHtml('Dashboard', refreshBar(live), `${onboarding()}${platformCards(o)}${budgetSection(o)}`);
      bindRefresh(main);
      bindBudget(main);
      return;
    }
    const ranges = [7, 14, 30].map((d) => `<button type="button" data-range="${d}" aria-pressed="${state.range === d}">${d} hari</button>`).join('');
    const filters = `<option value="all">Semua platform</option>${IDS.map((id) => `<option value="${id}" ${state.filter === id ? 'selected' : ''}>${esc(o.platforms[id].label)}</option>`).join('')}`;
    const body = `${headline(o)}${platformCards(o)}
      <div class="chart-grid">
        <section class="card wide"><div class="card-head"><h2>Biaya harian</h2><div class="seg-ctl" role="group" aria-label="Rentang waktu">${ranges}</div></div><div id="dailyHost">${dailyChart(o)}</div></section>
        <section class="card"><div class="card-head"><h2>Kumulatif bulan ini vs budget</h2></div>${cumulativeChart(o)}</section>
        <section class="card"><div class="card-head"><h2>Porsi per platform</h2></div>${shareChart(o)}</section>
        <section class="card wide"><div class="card-head"><h2>Server dengan biaya terbesar</h2><span class="muted">estimasi per bulan</span></div>${topChart(o)}</section>
      </div>
      <section class="section"><h2>Penggunaan per platform</h2>${usageTable(o)}</section>
      <section class="section"><div class="card-head"><h2>Server terdaftar</h2><label class="row" style="gap:6px">Filter<select id="srvFilter" style="width:auto">${filters}</select></label></div><div id="srvHost">${serverTable(o)}</div></section>
      ${savingsSection(o)}
      ${anomalySection(o)}
      ${budgetSection(o)}`;
    main.innerHTML = pageHtml('Dashboard', refreshBar(live), body);
    bindRefresh(main);
    C.bind(main);
    main.querySelectorAll('[data-range]').forEach((b) =>
      b.addEventListener('click', () => {
        state.range = Number(b.dataset.range);
        $('#dailyHost').innerHTML = dailyChart(o);
        C.bind($('#dailyHost'));
        main.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      })
    );
    $('#srvFilter').addEventListener('change', (e) => {
      state.filter = e.target.value;
      $('#srvHost').innerHTML = serverTable(o);
    });
    bindBudget(main);
  }

  const refreshBar = (live) => `<div class="row">${live}<button class="btn small" type="button" id="refreshBtn">Refresh</button></div>`;

  // Refresh: baca ulang status server dan bills dari semua platform yang tersambung, lalu gambar ulang.
  function bindRefresh(main) {
    $('#refreshBtn').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'Memperbarui...';
      const st = await api('GET', '/api/overview').then((x) => x.status).catch(() => ({}));
      await Promise.all(IDS.filter((id) => st[id]?.configured).map((id) => api('POST', `/api/cloud/${id}/sync`).catch(() => null)));
      const y = main.querySelector('.page')?.scrollTop || 0;
      await render(main).catch((err) => toast(err.message));
      const p = main.querySelector('.page');
      if (p) p.scrollTop = y;
      toast('Data diperbarui');
    });
  }

  function bindBudget(main) {
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
        await api('POST', '/api/budget', { amount: Number($('#bAmt').value), mode });
        toast(mode === 'set' ? 'Budget ditetapkan' : mode === 'subtract' ? 'Budget dikurangi' : 'Budget ditambah');
        render(main);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // Muat ulang tiap 60 detik selama Dashboard terbuka, supaya server yang baru dinyalakan atau dimatikan langsung terlihat.
  // Dilewati kalau pengguna sedang mengetik di form atau tab browser tidak aktif.
  async function page(main) {
    await render(main);
    A.setPollTimer(setInterval(() => {
      if (document.hidden || !location.hash.startsWith('#/overview')) return;
      if (main.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const y = main.querySelector('.page')?.scrollTop || 0;
      render(main).then(() => { const p = main.querySelector('.page'); if (p) p.scrollTop = y; }).catch(() => {});
    }, 60000));
  }

  window.Pages.overview = page;
})();
