'use strict';
// Grafik SVG kecil tanpa library: batang bertumpuk, garis dengan area, dan donat.
// Semua pembuat grafik mengembalikan string HTML. Interaksi (tooltip, sorot) dipasang lewat Charts.bind().
// Setiap grafik punya label aksesibel, dan datanya selalu tersedia juga sebagai tabel di halaman pemanggil.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (n, d = 2) => {
    if (n == null || !Number.isFinite(n)) return '-';
    if (Math.abs(n) < 0.00005) n = 0;
    const a = Math.abs(n);
    return (n < 0 ? '-$' : '$') + a.toFixed(a > 0 && a < 0.01 && d < 3 ? 4 : d);
  };
  const short = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}rb` : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  };
  const SER = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
  let uid = 0;

  // series: [{key,label}], rows: [{date, label?, proj?, <key>: number}]
  function bars({ rows, series, label, height = 190 }) {
    const id = `c${++uid}`;
    const W = 720, H = height, L = 46, R = 8, T = 10, B = 24;
    const iw = W - L - R, ih = H - T - B;
    const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
    const max = niceMax(Math.max(...totals, 0.000001));
    const bw = iw / rows.length;
    const y = (v) => T + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
    }
    let b = '';
    rows.forEach((r, i) => {
      let acc = 0;
      const x = L + i * bw + bw * 0.12;
      const w = Math.max(1, bw * 0.76);
      series.forEach((s, k) => {
        const v = r[s.key] || 0;
        if (v <= 0) return;
        b += `<rect class="bar${r.proj ? ' proj' : ''}" x="${x.toFixed(2)}" y="${y(acc + v).toFixed(2)}" width="${w.toFixed(2)}" height="${Math.max(0, (v / max) * ih).toFixed(2)}" fill="${s.color || SER[k % 4]}" data-i="${i}" style="--d:${Math.min(i * 6, 400)}ms"/>`;
        acc += v;
      });
      b += `<rect class="hit" x="${(L + i * bw).toFixed(2)}" y="${T}" width="${bw.toFixed(2)}" height="${ih}" data-i="${i}"/>`;
    });
    const first = rows[0], last = rows[rows.length - 1];
    const axis = `<text class="tick" x="${L}" y="${H - 6}">${esc(first.label || first.date)}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last.label || last.date)}</text>`;
    const split = rows.findIndex((r) => r.proj);
    const divider = split > 0 ? `<line class="divider" x1="${(L + split * bw).toFixed(2)}" x2="${(L + split * bw).toFixed(2)}" y1="${T}" y2="${T + ih}"/><text class="tick" x="${(L + split * bw + 4).toFixed(2)}" y="${T + 10}">proyeksi</text>` : '';
    const data = esc(JSON.stringify({ rows: rows.map((r, i) => ({ date: r.date, proj: !!r.proj, total: totals[i], parts: series.map((s) => [s.label, r[s.key] || 0]) })) }));
    return `<div class="chartbox" data-chart="${id}" data-info="${data}"><svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">${g}${divider}${b}${axis}</svg><div class="tip" role="status" aria-live="polite"></div></div>`;
  }

  // rows: [{date, v}]; opsional band: [{date, lo, hi}] untuk rentang forecast
  // Kurva monoton (Fritsch-Carlson): halus tetapi tidak melewati titik data (tidak ada lonjakan palsu).
  function smooth(pts) {
    const n = pts.length;
    if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : '';
    if (n === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
    const d = [], m = [];
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let p = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = (pts[i + 1][0] - pts[i][0]) / 3;
      p += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + m[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return p;
  }

  // Grafik garis multi-seri. Garis digambar di SVG yang meregang mengikuti lebar kartu, sedangkan label sumbu,
  // titik sorot, dan tooltip berupa HTML supaya teks tidak ikut melar.
  // rows: [{date, label?, proj?, <key>: number}], series: [{key, label, color, area?}]
  function lines({ rows, series, label, height = 220, refLine, refLabel }) {
    if (!rows.length || !series.length) return '';
    const id = `c${++uid}`;
    const VW = 1000, VH = 300;
    const n = rows.length;
    const max = niceMax(Math.max(...rows.flatMap((r) => series.map((s) => r[s.key] || 0)), refLine || 0, 0.000001));
    const X = (i) => (n === 1 ? VW / 2 : (i / (n - 1)) * VW);
    const Y = (v) => VH - (v / max) * VH;
    const split = rows.findIndex((r) => r.proj);
    const histEnd = split < 0 ? n : Math.max(1, split);
    let defs = '', paths = '';
    series.forEach((s, k) => {
      const pts = rows.map((r, i) => [X(i), Y(r[s.key] || 0)]);
      const hist = pts.slice(0, histEnd);
      const proj = split < 0 ? [] : pts.slice(histEnd - 1);
      const area = s.area ?? series.length === 1;
      if (area && hist.length > 1) {
        const gid = `${id}g${k}`;
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${s.color};stop-opacity:.28"/><stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient>`;
        paths += `<path class="lc-area" d="${smooth(hist)}L${hist[hist.length - 1][0].toFixed(1)},${VH}L${hist[0][0].toFixed(1)},${VH}Z" fill="url(#${gid})"/>`;
      }
      paths += `<path class="lc-ln${s.bold ? ' bold' : ''}" d="${smooth(hist)}" style="stroke:${s.color}"/>`;
      if (proj.length > 1) paths += `<path class="lc-ln proj${s.bold ? ' bold' : ''}" d="${smooth(proj)}" style="stroke:${s.color}"/>`;
    });
    let grid = '', ylab = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      grid += `<line class="lc-grid" x1="0" x2="${VW}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      ylab += `<span style="top:${(100 - (v / max) * 100).toFixed(2)}%">${esc(short(v))}</span>`;
    }
    const ticks = Math.min(n, 6);
    let xlab = '';
    for (let t = 0; t < ticks; t++) {
      const i = ticks === 1 ? 0 : Math.round((t / (ticks - 1)) * (n - 1));
      const cls = t === 0 ? 'first' : t === ticks - 1 ? 'last' : '';
      xlab += `<span class="${cls}" style="left:${((X(i) / VW) * 100).toFixed(2)}%">${esc(rows[i].label || rows[i].date)}</span>`;
    }
    let marks = '';
    if (split > 0) {
      const xp = ((X(histEnd - 1) / VW) * 100).toFixed(2);
      grid += `<line class="lc-today" x1="${X(histEnd - 1)}" x2="${X(histEnd - 1)}" y1="0" y2="${VH}"/>`;
      marks += `<span class="lc-mark" style="left:${xp}%">hari ini</span>`;
    }
    if (refLine) {
      grid += `<line class="lc-ref" x1="0" x2="${VW}" y1="${Y(refLine)}" y2="${Y(refLine)}"/>`;
      marks += `<span class="lc-refl" style="top:${(100 - (refLine / max) * 100).toFixed(2)}%">${esc(refLabel || usd(refLine))}</span>`;
    }
    const info = { max, rows: rows.map((r) => ({ date: r.label || r.date, proj: !!r.proj, vals: series.map((s) => r[s.key] || 0) })), series: series.map((s) => ({ label: s.label, color: s.color })) };
    return `<div class="lc" data-lc="${esc(JSON.stringify(info))}" style="height:${height}px">
      <div class="lc-y" aria-hidden="true">${ylab}</div>
      <div class="lc-plot" tabindex="0" role="img" aria-label="${esc(label)}">
        <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true"><defs>${defs}</defs>${grid}${paths}</svg>
        ${marks}<div class="lc-xh"></div>${series.map((s) => `<i class="lc-dot" style="background:${s.color}"></i>`).join('')}<div class="tip" role="status" aria-live="polite"></div>
      </div>
      <div class="lc-x" aria-hidden="true">${xlab}</div>
    </div>`;
  }

  function bindLines(root) {
    root.querySelectorAll('.lc').forEach((box) => {
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      let info;
      try { info = JSON.parse(box.dataset.lc); } catch { return; }
      const plot = box.querySelector('.lc-plot');
      const tip = plot.querySelector('.tip');
      const xh = plot.querySelector('.lc-xh');
      const dots = [...plot.querySelectorAll('.lc-dot')];
      const n = info.rows.length;
      let cur = n - 1;
      const show = (i) => {
        cur = i;
        const r = info.rows[i];
        const xp = n === 1 ? 50 : (i / (n - 1)) * 100;
        xh.style.left = `${xp}%`;
        xh.classList.add('on');
        dots.forEach((d, k) => {
          d.style.left = `${xp}%`;
          d.style.top = `${100 - (r.vals[k] / info.max) * 100}%`;
          d.classList.add('on');
        });
        tip.innerHTML = `<strong>${esc(r.date)}${r.proj ? ' (perkiraan)' : ''}</strong>${info.series.map((s, k) => `<div><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${esc(usd(r.vals[k]))}</b></div>`).join('')}`;
        tip.classList.add('on');
        const w = plot.clientWidth;
        const px = (xp / 100) * w;
        tip.style.left = `${px > w - 200 ? Math.max(0, px - 200) : px + 12}px`;
        tip.style.top = '0px';
      };
      const hide = () => {
        tip.classList.remove('on');
        xh.classList.remove('on');
        dots.forEach((d) => d.classList.remove('on'));
      };
      const at = (clientX) => {
        const b = plot.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (clientX - b.left) / b.width));
        return Math.round(f * (n - 1));
      };
      plot.addEventListener('mousemove', (e) => show(at(e.clientX)));
      plot.addEventListener('mouseleave', hide);
      plot.addEventListener('touchstart', (e) => show(at(e.touches[0].clientX)), { passive: true });
      plot.addEventListener('focus', () => show(cur));
      plot.addEventListener('blur', hide);
      plot.addEventListener('keydown', (e) => {
        const k = { ArrowRight: Math.min(n - 1, cur + 1), ArrowLeft: Math.max(0, cur - 1), Home: 0, End: n - 1 }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        show(k);
      });
    });
  }

  // Satu seri: dipakai grafik kumulatif dan planning.
  function line({ rows, label, height = 200, color = 'var(--s1)', refLine, refLabel, valueLabel = 'Biaya' }) {
    return lines({ rows: rows.map((r) => ({ ...r, label: r.label || r.date })), series: [{ key: 'v', label: valueLabel, color, area: true }], label, height, refLine, refLabel });
  }

  function donut({ slices, label, size = 150, center }) {
    const total = slices.reduce((a, s) => a + s.value, 0);
    if (total <= 0) return '';
    const r = 54, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = slices
      .map((s, k) => {
        const len = (s.value / total) * c;
        const el = `<circle class="arc" cx="70" cy="70" r="${r}" fill="none" stroke="${s.color || SER[k % 4]}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)" data-k="${k}"><title>${esc(s.label)}: ${esc(usd(s.value))}</title></circle>`;
        off += len;
        return el;
      })
      .join('');
    const legend = slices.map((s, k) => `<li><i style="background:${s.color || SER[k % 4]}"></i><span>${esc(s.label)}</span><b>${esc(usd(s.value))}</b><em>${((s.value / total) * 100).toFixed(0)}%</em></li>`).join('');
    return `<div class="donutbox"><svg class="donut" width="${size}" height="${size}" viewBox="0 0 140 140" role="img" aria-label="${esc(label)}">${arcs}<text class="dc" x="70" y="66" text-anchor="middle">${esc(center?.top ?? usd(total))}</text><text class="dc2" x="70" y="84" text-anchor="middle">${esc(center?.bottom ?? 'total')}</text></svg><ul class="dlegend">${legend}</ul></div>`;
  }

  // Batang horizontal untuk perbandingan antar item. rows: [{label, value, color?, sub?}]; ref = garis batas (misalnya budget).
  function hbars({ rows, label, ref, refLabel }) {
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.value), ref || 0, 0.000001);
    const mark = ref ? `<i class="hm" style="left:${((ref / max) * 100).toFixed(2)}%"></i>` : '';
    const items = rows
      .map((r, k) => `<li style="--d:${k * 40}ms"><span class="hl" title="${esc(r.label)}">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><span class="ht"><span class="hb${ref && r.value > ref ? ' over' : ''}" style="width:${((r.value / max) * 100).toFixed(2)}%;${r.color ? `background:${r.color}` : ''}"></span>${mark}</span><b>${esc(usd(r.value))}</b></li>`)
      .join('');
    const cap = ref ? `<p class="hcap"><i class="hm-key"></i>${esc(refLabel || `batas ${usd(ref)}`)}</p>` : '';
    return `<div class="hbars" role="img" aria-label="${esc(label)}"><ul>${items}</ul>${cap}</div>`;
  }

  // Pasang tooltip pada semua grafik di dalam root. Aman dipanggil berulang.
  function bind(root) {
    root.querySelectorAll('.chartbox').forEach((box) => {
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      let info;
      try {
        info = JSON.parse(box.dataset.info);
      } catch {
        return;
      }
      const tip = box.querySelector('.tip');
      const show = (i, ev) => {
        const r = info.rows[i];
        if (!r) return;
        box.querySelectorAll('.bar.on').forEach((e) => e.classList.remove('on'));
        box.querySelectorAll(`.bar[data-i="${i}"]`).forEach((e) => e.classList.add('on'));
        const parts = r.parts.filter((p) => p[1] > 0).map((p) => `<div><span>${esc(p[0])}</span><b>${esc(usd(p[1]))}</b></div>`).join('');
        tip.innerHTML = `<strong>${esc(r.date)}${r.proj ? ' (proyeksi)' : ''}</strong><div class="tt"><span>Total</span><b>${esc(usd(r.total))}</b></div>${parts}`;
        tip.classList.add('on');
        const b = box.getBoundingClientRect();
        const x = ev ? ev.clientX - b.left : (i / Math.max(1, info.rows.length - 1)) * b.width;
        tip.style.left = `${Math.min(Math.max(8, x + 12), b.width - 190)}px`;
        tip.style.top = '4px';
      };
      const hide = () => {
        tip.classList.remove('on');
        box.querySelectorAll('.bar.on').forEach((e) => e.classList.remove('on'));
      };
      box.addEventListener('mousemove', (e) => {
        const h = e.target.closest('.hit');
        if (h) show(Number(h.dataset.i), e);
      });
      box.addEventListener('mouseleave', hide);
      // Sentuh dan keyboard: grafik bisa difokuskan dan dijelajahi dengan tombol panah.
      const svg = box.querySelector('svg');
      svg.setAttribute('tabindex', '0');
      let cur = info.rows.length - 1;
      svg.addEventListener('focus', () => show(cur));
      svg.addEventListener('blur', hide);
      svg.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') cur = Math.min(info.rows.length - 1, cur + 1);
        else if (e.key === 'ArrowLeft') cur = Math.max(0, cur - 1);
        else if (e.key === 'Home') cur = 0;
        else if (e.key === 'End') cur = info.rows.length - 1;
        else return;
        e.preventDefault();
        show(cur);
      });
      box.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const el = document.elementFromPoint(t.clientX, t.clientY)?.closest('.hit');
        if (el) show(Number(el.dataset.i), t);
      }, { passive: true });
    });
  }

  window.Charts = { bars, line, lines, donut, hbars, bind: (root) => { bind(root); bindLines(root); }, usd, short };
})();
