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

  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const monthName = (ym) => BULAN[Number(String(ym).slice(5, 7)) - 1] || ym;

  function headline(o) {
    const b = o.budget;
    const t = o.totals;
    const pct = b.amount > 0 ? (t.forecast / b.amount) * 100 : 0;
    const meter = b.amount > 0
      ? `<div class="meter ${b.over ? 'over' : ''}" role="img" aria-label="Perkiraan ${pct.toFixed(0)} persen dari budget"><span style="width:${Math.min(100, pct)}%"></span></div>
         <p class="sub">${b.over ? `Lebih ${usd(t.forecast - b.amount)} dari budget ${usd(b.amount)}.` : `${pct.toFixed(0)}% dari budget ${usd(b.amount)}.`}</p>`
      : '<p class="sub">Budget belum diatur. Atur di bagian Budget di bawah.</p>';
    // Tren kecil di kartu utama: biaya harian 3 minggu terakhir lalu forecast sampai akhir bulan.
    const hist = o.series.slice(-21).map((r) => r.total);
    const proj = o.projection.map((r) => r.total);
    const tile = (label, value, sub) => `<div class="kpi"><span class="kpi-l">${label}</span><b class="kpi-v">${value}</b><small>${sub}</small></div>`;
    return `<div class="kpis">
      <section class="kpi hero" aria-label="Total bill bulan ini">
        <div class="kpi-top"><span class="kpi-l">Total bill ${esc(monthName(o.month))}</span><span class="kpi-tag">forecast</span></div>
        <div class="big">${usd(t.forecast)}</div>
        ${meter}
        <div class="hero-spark">${C.spark({ values: [...hist, ...proj], proj: proj.length, height: 54 })}</div>
      </section>
      ${tile('Biaya per hari', usd(t.perDay), 'dari kondisi server sekarang')}
      ${tile('Sudah terpakai', usd(t.mtd), t.credit > 0 ? `${usd(t.credit)} ditutup credits` : `1 sampai ${new Date().getUTCDate()} ${esc(monthName(o.month))}`)}
      ${tile('Sisa bulan ini', usd(t.remaining), `${o.daysLeft} hari lagi`)}
      ${tile('Budget tersisa', usd(b.remaining), `dari ${usd(b.amount)}`)}
    </div>`;
  }

  function platformCards(o) {
    const total = o.totals.forecast || 0;
    return `<div class="sources">${IDS.map((id) => {
      const p = o.platforms[id];
      if (!p.configured) {
        return `<a class="source off" href="#/integrations/${id}"><span class="nm">${L.badge(id, 'logo')}${esc(p.label)}</span>
          <span class="st">Belum tersambung</span><span class="src-cta">Sambungkan akun</span></a>`;
      }
      const share = total > 0 ? (p.forecastMonth / total) * 100 : 0;
      const vals = o.series.slice(-14).map((r) => r[id] || 0);
      return `<a class="source" href="#/integrations/${id}">
        <span class="nm">${L.badge(id, 'logo')}${esc(p.label)}<span class="src-state"><i class="on-dot"></i>${p.running} running</span></span>
        <span class="am">${usd(p.forecastMonth)}</span>
        <span class="share" role="img" aria-label="${share.toFixed(0)} persen dari total"><span style="width:${share.toFixed(1)}%;background:${COLOR[id]}"></span></span>
        <span class="st">${share.toFixed(0)}% dari total, ${p.stopped} stopped</span>
        ${C.spark({ values: vals, color: COLOR[id], height: 30 })}
      </a>`;
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

  // Grafik 4: biaya bulan ini per server (sudah terpakai + sisa bulan), satuannya sama dengan total bill.
  function topChart(o) {
    const rows = [...o.servers].sort((a, b) => b.month - a.month).slice(0, 6).map((s) => ({ label: s.name, sub: `${o.platforms[s.provider].label}, ${s.type}, ${s.state}`, value: s.month, color: COLOR[s.provider] }));
    rows.sort((a, b) => b.value - a.value);
    if (!rows.length) return '<p class="chart-empty">Belum ada server.</p>';
    return C.hbars({ rows: rows.slice(0, 6), label: 'Biaya bulan ini per server' });
  }

  // ---------- widget tambahan (semua dari data server dan bills yang sudah ada) ----------
  const PARTS = [
    { key: 'compute', label: 'Compute', color: 'var(--s1)' },
    { key: 'disk', label: 'Disk', color: 'var(--p-azure)' },
    { key: 'ip', label: 'IPv4 publik', color: 'var(--p-gcp)' },
    { key: 'snapshot', label: 'Snapshot', color: 'var(--s3)' },
    { key: 'transfer', label: 'Data transfer', color: 'var(--s4)' },
  ];

  // Komposisi biaya bulan ini per komponen: di mana uang sebenarnya habis.
  function compositionWidget(o) {
    const agg = {};
    for (const s of o.servers) for (const b of s.breakdown || []) agg[b.key] = (agg[b.key] || 0) + b.used + b.rest;
    const slices = PARTS.map((p) => ({ label: p.label, value: agg[p.key] || 0, color: p.color })).filter((x) => x.value > 0.00005);
    if (!slices.length) return '<p class="chart-empty">Belum ada biaya.</p>';
    return C.donut({ slices, label: 'Komposisi biaya bulan ini per komponen', size: 132, center: { top: usd(slices.reduce((a, x) => a + x.value, 0)), bottom: 'bulan ini' } });
  }

  // Bulan ini dibanding periode yang sama bulan lalu (tanggal 1 sampai hari ini). Butuh data bulan lalu di series.
  function momWidget(o) {
    const now = new Date();
    const d = now.getUTCDate();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const sumMonth = (ym) => o.series.filter((r) => r.date.startsWith(ym) && Number(r.date.slice(8)) <= d).reduce((a, r) => a + r.total, 0);
    const cur = o.totals.mtd;
    const hasPrev = o.series.some((r) => r.date.startsWith(prev) && Number(r.date.slice(8)) === 1);
    const last = sumMonth(prev);
    if (!hasPrev) return `<div class="mini"><b class="mini-v">${usd(cur)}</b><span class="mini-s">Data bulan lalu belum lengkap untuk dibandingkan.</span></div>`;
    const diff = cur - last;
    const pct = last > 0 ? (diff / last) * 100 : 0;
    const dir = Math.abs(diff) < 0.005 ? 'flat' : diff > 0 ? 'up' : 'down';
    return `<div class="mini"><b class="mini-v">${usd(cur)}</b>
      <span class="delta ${dir}">${dir === 'flat' ? 'Sama' : `${dir === 'up' ? 'Naik' : 'Turun'} ${usd(Math.abs(diff))}${last > 0 ? ` (${Math.abs(pct).toFixed(0)}%)` : ''}`}</span>
      <span class="mini-s">vs ${usd(last)} pada 1 sampai ${d} bulan lalu</span>
      <div class="mini-bars"><span style="--w:${last + cur > 0 ? ((last / Math.max(last, cur)) * 100).toFixed(1) : 0}%"><i></i>Bulan lalu</span><span class="cur" style="--w:${last + cur > 0 ? ((cur / Math.max(last, cur)) * 100).toFixed(1) : 0}%"><i></i>Bulan ini</span></div></div>`;
  }

  // Budget runway: kalau biaya per hari tetap seperti sekarang, kapan budget bulan ini habis.
  function runwayWidget(o) {
    const b = o.budget;
    const t = o.totals;
    if (!b.amount) return '<p class="chart-empty">Budget belum diatur.</p>';
    const left = b.amount - t.mtd;
    const pctUsed = Math.min(100, (t.mtd / b.amount) * 100);
    const pctForecast = Math.min(100, (t.forecast / b.amount) * 100);
    let line;
    if (left <= 0) line = 'Budget bulan ini sudah habis.';
    else if (t.perDay <= 0) line = 'Tidak ada biaya berjalan, budget aman.';
    else {
      const days = Math.floor(left / t.perDay);
      line = days > o.daysLeft ? `Cukup sampai akhir bulan, sisa sekitar ${usd(b.amount - t.forecast)}.` : `Habis dalam sekitar ${days} hari dengan ${usd(t.perDay)} per hari.`;
    }
    return `<div class="mini"><b class="mini-v">${pctUsed.toFixed(0)}%<small> terpakai</small></b>
      <div class="gauge" role="img" aria-label="${pctUsed.toFixed(0)} persen budget terpakai, forecast ${pctForecast.toFixed(0)} persen"><span class="used" style="width:${pctUsed}%"></span><span class="fc" style="left:${pctUsed}%;width:${Math.max(0, pctForecast - pctUsed)}%"></span></div>
      <div class="gauge-l"><span>${usd(t.mtd)} terpakai</span><span>forecast ${usd(t.forecast)}</span><span>${usd(b.amount)}</span></div>
      <span class="mini-s">${line}</span></div>`;
  }

  // Biaya rata-rata per hari dalam seminggu: hari mana yang paling mahal (pola jadwal server).
  function weekdayWidget(o) {
    const NAMA = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const acc = Array.from({ length: 7 }, () => ({ s: 0, n: 0 }));
    const today = new Date().toISOString().slice(0, 10);
    for (const r of o.series.slice(-28)) {
      if (r.date === today) continue;
      const w = new Date(r.date + 'T00:00:00Z').getUTCDay();
      acc[w].s += r.total;
      acc[w].n += 1;
    }
    const avg = acc.map((x) => (x.n ? x.s / x.n : 0));
    const max = Math.max(...avg, 0.000001);
    if (!avg.some((v) => v > 0)) return '<p class="chart-empty">Belum ada biaya harian.</p>';
    const order = [1, 2, 3, 4, 5, 6, 0];
    return `<div class="wkbars" role="img" aria-label="Rata-rata biaya per hari dalam seminggu, 4 minggu terakhir">${order
      .map((w) => `<div class="wk${avg[w] === max ? ' top' : ''}" title="${NAMA[w]}: ${esc(usd(avg[w]))}"><span class="wk-v">${esc(usd(avg[w]))}</span><span class="wk-b"><i style="height:${((avg[w] / max) * 100).toFixed(1)}%"></i></span><span class="wk-l">${NAMA[w]}</span></div>`)
      .join('')}</div><p class="mini-s">Rata-rata 4 minggu terakhir.</p>`;
  }

  // Kalender biaya bulan ini: satu kotak per hari, makin pekat makin mahal. Hari mendatang berupa forecast.
  function calendarWidget(o) {
    const now = new Date();
    const y = now.getUTCFullYear(), mo = now.getUTCMonth();
    const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const first = (new Date(Date.UTC(y, mo, 1)).getUTCDay() + 6) % 7; // Senin = 0
    const byDate = new Map(o.series.map((r) => [r.date, r.total]));
    for (const r of o.projection) byDate.set(r.date, r.total);
    const vals = [];
    for (let d = 1; d <= dim; d++) vals.push(byDate.get(`${o.month}-${String(d).padStart(2, '0')}`) || 0);
    const max = Math.max(...vals, 0.000001);
    const todayN = now.getUTCDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<span class="cd pad"></span>');
    vals.forEach((v, i) => {
      const d = i + 1;
      const lvl = v <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4));
      cells.push(`<span class="cd l${lvl}${d > todayN ? ' fut' : ''}${d === todayN ? ' now' : ''}" title="${d} ${esc(monthName(o.month))}: ${esc(usd(v))}${d > todayN ? ' (forecast)' : ''}"><em>${d}</em></span>`);
    });
    return `<div class="cal-h">${['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="cal" role="img" aria-label="Kalender biaya harian ${esc(monthName(o.month))}">${cells.join('')}</div>
      <div class="cal-k"><span>Rendah</span>${[1, 2, 3, 4].map((l) => `<i class="cd l${l}"></i>`).join('')}<span>Tinggi</span><span class="cal-f"><i class="cd l2 fut"></i>Forecast</span></div>`;
  }

  // Jam compute bulan ini: server running menghabiskan jam berbayar; stopped tidak.
  function computeWidget(o) {
    const run = o.servers.filter((s) => s.state === 'running');
    const hoursSoFar = (new Date().getUTCDate() - 1) * 24 + new Date().getUTCHours();
    const compute = o.servers.reduce((a, s) => a + ((s.breakdown || []).find((b) => b.key === 'compute')?.used || 0), 0);
    const vcpu = run.reduce((a, s) => a + (s.vcpu || 0), 0);
    const mem = run.reduce((a, s) => a + (s.memGiB || 0), 0);
    const disk = o.servers.reduce((a, s) => a + (s.diskGB || 0), 0);
    const cell = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
    return `<div class="specs">${cell(`${run.length}/${o.servers.length}`, 'server running')}${cell(vcpu, 'vCPU aktif')}${cell(`${mem.toFixed(1)} GiB`, 'RAM aktif')}${cell(`${disk} GB`, 'disk total')}${cell(usd(compute), 'compute bulan ini')}${cell(`${run.length * hoursSoFar} jam`, 'jam running bila nyala terus')}</div>`;
  }

  // Server yang biayanya naik atau perlu dicek: stopped tapi masih bayar disk, IP publik di server stopped, dll.
  function alertsWidget(o) {
    const items = [];
    const b = o.budget;
    if (b.amount && b.over) items.push({ lvl: 'bad', text: `Forecast ${usd(o.totals.forecast)} melewati budget ${usd(b.amount)}.` });
    for (const a of o.anomalies.slice(0, 2)) items.push({ lvl: 'warn', text: `Lonjakan ${a.label} pada ${a.date}: ${usd(a.actual)}, biasanya ${usd(a.expected)}.` });
    for (const s of o.savings.slice(0, 3)) items.push({ lvl: 'info', text: `${s.server.name}: ${s.text}`, amt: s.monthly });
    const off = IDS.filter((id) => !o.platforms[id].configured).map((id) => o.platforms[id].label);
    if (off.length) items.push({ lvl: 'muted', text: `${off.join(' dan ')} belum tersambung.` });
    if (!items.length) return '<p class="chart-empty">Tidak ada yang perlu dicek.</p>';
    return `<ul class="alerts">${items.map((x) => `<li class="al-${x.lvl}"><span>${esc(x.text)}</span>${x.amt ? `<b>${usd(x.amt)}/bln</b>` : ''}</li>`).join('')}</ul>`;
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
      <td>${r.p.configured ? '<span class="s-ok">Tersambung</span>' : '<span class="muted">Belum tersambung</span>'}</td></tr>`;
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Platform</th><th scope="col" class="num">Running / total</th><th scope="col" class="num">vCPU aktif</th><th scope="col" class="num">RAM aktif</th><th scope="col" class="num">Disk</th><th scope="col" class="num">Terpakai</th><th scope="col" class="num">Per hari</th><th scope="col" class="num">Akhir bulan</th><th scope="col">Koneksi</th></tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td class="num">${o.totals.running} / ${o.servers.length}</td><td class="num">${sum('vcpu')}</td><td class="num">${sum('mem').toFixed(1)} GiB</td><td class="num">${sum('disk')} GB</td><td class="num">${usd(o.totals.mtd)}</td><td class="num">${usd(o.totals.perDay)}</td><td class="num">${usd(o.totals.forecast)}</td><td></td></tr></tfoot></table></div>`;
  }

  // Kolom: sudah terpakai + sisa bulan ini = bulan ini. Penjumlahan semua baris sama dengan total bill di atas.
  function serverTable(o) {
    const list = o.servers.filter((s) => state.filter === 'all' || s.provider === state.filter).sort((a, b) => b.month - a.month);
    if (!list.length) return '<p class="muted">Tidak ada server untuk filter ini.</p>';
    const now = (s) => (s.state === 'running' ? `${usd(s.daily)} per hari` : `${usd(s.daily)} per hari, disk saja`);
    const PART = { compute: 'Compute', disk: 'Disk', ip: 'IPv4 publik', snapshot: 'Snapshot', transfer: 'Data transfer', other: 'Lainnya' };
    const rows = list
      .map((s) => `<tr class="srv"><td>${esc(s.name)}</td><td><span class="cell-logo">${L.badge(s.provider, 'logo xs')}${esc(o.platforms[s.provider].label)}</span></td><td>${esc(s.location)}</td><td><code>${esc(s.type)}</code></td>
        <td>${s.vcpu ? `${s.vcpu} vCPU, ${s.memGiB} GiB, ` : ''}${s.diskGB} GB disk</td><td><span class="status s-${esc(s.state)}">${esc(STATE[s.state] || s.state)}</span><br><span class="muted">${now(s)}</span></td>
        <td class="num">${usd(s.used)}</td><td class="num">${usd(s.rest)}</td><td class="num"><b>${usd(s.month)}</b></td></tr>
        ${(s.breakdown || []).map((b) => `<tr class="sub"><td colspan="6">${esc(PART[b.key])}${b.key === 'disk' ? ` ${s.diskGB} GB` : ''}</td><td class="num">${usd(b.used)}</td><td class="num">${usd(b.rest)}</td><td class="num">${usd(b.used + b.rest)}</td></tr>`).join('')}`)
      .join('');
    const sum = (k) => list.reduce((a, s) => a + s[k], 0);
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Server</th><th scope="col">Platform</th><th scope="col">Lokasi</th><th scope="col">Tipe</th><th scope="col">Spesifikasi</th><th scope="col">Status</th><th scope="col" class="num">Sudah terpakai</th><th scope="col" class="num">Sisa bulan ini</th><th scope="col" class="num">Bulan ini</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row" colspan="6">Total</th><td class="num">${usd(sum('used'))}</td><td class="num">${usd(sum('rest'))}</td><td class="num">${usd(sum('used') + sum('rest'))}</td></tr></tfoot></table></div>`;
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
        <section class="card wide"><div class="card-head"><h2>Biaya harian dan forecast</h2><div class="seg-ctl" role="group" aria-label="Rentang waktu">${ranges}</div></div><div id="dailyHost">${dailyChart(o)}</div></section>
        <section class="card"><div class="card-head"><h2>Kumulatif bulan ini vs budget</h2></div>${cumulativeChart(o)}</section>
        <section class="card"><div class="card-head"><h2>Porsi per platform</h2></div>${shareChart(o)}</section>
        <section class="card"><div class="card-head"><h2>Komposisi biaya</h2><span class="muted">bulan ini</span></div>${compositionWidget(o)}</section>
        <section class="card"><div class="card-head"><h2>Budget runway</h2></div>${runwayWidget(o)}</section>
        <section class="card"><div class="card-head"><h2>Dibanding bulan lalu</h2></div>${momWidget(o)}</section>
        <section class="card"><div class="card-head"><h2>Perlu dicek</h2></div>${alertsWidget(o)}</section>
        <section class="card wide"><div class="card-head"><h2>Biaya bulan ini per server</h2></div>${topChart(o)}</section>
        <section class="card"><div class="card-head"><h2>Kalender biaya</h2><span class="muted">${esc(monthName(o.month))}</span></div>${calendarWidget(o)}</section>
        <section class="card"><div class="card-head"><h2>Biaya per hari dalam seminggu</h2></div>${weekdayWidget(o)}</section>
        <section class="card wide"><div class="card-head"><h2>Kapasitas aktif</h2></div>${computeWidget(o)}</section>
      </div>
      <section class="section"><h2>Penggunaan per platform</h2>${usageTable(o)}</section>
      <section class="section"><div class="card-head"><h2>Server terdaftar</h2><label class="row" style="gap:6px">Filter<select id="srvFilter" style="width:auto">${filters}</select></label></div><div id="srvHost">${serverTable(o)}</div></section>
      ${savingsSection(o)}
      ${anomalySection(o)}
      ${budgetSection(o)}`;
    main.innerHTML = pageHtml('Dashboard', refreshBar(live), body);
    countUp(main);
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

  // Angka dolar di kartu atas naik dari nol satu kali saat halaman pertama dibuka (bukan saat refresh otomatis),
  // supaya mata langsung tertuju ke angka utama. Dilewati kalau pengguna meminta gerak dikurangi.
  let counted = false;
  function countUp(main) {
    if (counted || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    counted = true;
    main.querySelectorAll('.big, .kpi-v').forEach((el) => {
      const m = /^\$([\d.]+)$/.exec(el.textContent.trim());
      if (!m) return;
      const to = Number(m[1]);
      const dec = (m[1].split('.')[1] || '').length;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 650);
        el.textContent = `$${(to * (1 - Math.pow(1 - k, 3))).toFixed(dec)}`;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  const refreshBar = (live) => `<div class="row">${live}<button class="btn small" type="button" id="refreshBtn">${L.icon('refresh')}<span>Refresh</span></button></div>`;

  // Refresh: baca ulang status server dan bills dari semua platform yang tersambung, lalu gambar ulang.
  function bindRefresh(main) {
    $('#refreshBtn').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.classList.add('spinning');
      b.querySelector('span').textContent = 'Memperbarui...';
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
