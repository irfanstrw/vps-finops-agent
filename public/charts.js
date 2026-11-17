'use strict';
// Grafik SVG kecil tanpa library: batang bertumpuk, garis dengan area, dan donat.
// Semua pembuat grafik mengembalikan string HTML. Interaksi (tooltip, sorot) dipasang lewat Charts.bind().
// Setiap grafik punya label aksesibel, dan datanya selalu tersedia juga sebagai tabel di halaman pemanggil.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (n, d = 2) => {
    if (n == null || !Number.isFinite(n)) return '-';
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
  function line({ rows, label, height = 190, color = 'var(--s1)', refLine, refLabel }) {
    const id = `c${++uid}`;
    const W = 720, H = height, L = 46, R = 8, T = 10, B = 24;
    const iw = W - L - R, ih = H - T - B;
    const vals = rows.map((r) => r.v);
    const max = niceMax(Math.max(...vals, refLine || 0, 0.000001));
    const x = (i) => L + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const y = (v) => T + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
    }
    const split = rows.findIndex((r) => r.proj);
    const pts = rows.map((r, i) => [x(i), y(r.v)]);
    const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const hist = split < 0 ? pts : pts.slice(0, split + (split > 0 ? 1 : 0));
    const proj = split < 0 ? [] : pts.slice(Math.max(0, split - 1));
    const area = hist.length > 1 ? `<path class="area" d="${path(hist)} L${hist[hist.length - 1][0].toFixed(1)},${T + ih} L${hist[0][0].toFixed(1)},${T + ih} Z" fill="${color}"/>` : '';
    const ref = refLine ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(refLine)}" y2="${y(refLine)}"/><text class="tick" x="${W - R}" y="${y(refLine) - 5}" text-anchor="end">${esc(refLabel || 'batas')}</text>` : '';
    const first = rows[0], last = rows[rows.length - 1];
    const axis = `<text class="tick" x="${L}" y="${H - 6}">${esc(first.date)}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last.date)}</text>`;
    const hits = rows.map((r, i) => `<rect class="hit" x="${(x(i) - iw / rows.length / 2).toFixed(1)}" y="${T}" width="${(iw / rows.length).toFixed(1)}" height="${ih}" data-i="${i}"/>`).join('');
    const dots = rows.length <= 40 ? pts.map((p, i) => `<circle class="dot${rows[i].proj ? ' proj' : ''}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${color}"/>`).join('') : '';
    const data = esc(JSON.stringify({ rows: rows.map((r) => ({ date: r.date, proj: !!r.proj, total: r.v, parts: [] })) }));
    return `<div class="chartbox" data-chart="${id}" data-info="${data}"><svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">${g}${ref}${area}<path class="ln" d="${path(hist)}" stroke="${color}" fill="none"/>${proj.length > 1 ? `<path class="ln proj" d="${path(proj)}" stroke="${color}" fill="none"/>` : ''}${dots}${hits}${axis}</svg><div class="tip" role="status" aria-live="polite"></div></div>`;
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

  window.Charts = { bars, line, donut, hbars, bind, usd, short };
})();
