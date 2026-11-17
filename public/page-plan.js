'use strict';
// Mode Perencanaan: hitung proyeksi biaya dari daftar sumber daya tanpa server asli dan tanpa biaya apa pun.
// Tidak menyentuh saldo, forecast, atau riwayat. Rencana bisa disimpan, dibandingkan, dan diunduh sebagai CSV.
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml, confirmInline } = A;
  const C = window.Charts;
  const L = window.Logos;

  let cat = null;
  let items = [];
  let timer = null;
  let lastCalc = null;

  const PRESETS = [
    { name: 'Web kecil', items: [{ kind: 'ec2', type: 't3a.small', qty: 1 }, { kind: 'ebs', qty: 30 }, { kind: 'egress', qty: 150 }] },
    { name: 'Aplikasi dengan load balancer', items: [{ kind: 'ec2', type: 't3a.medium', qty: 2 }, { kind: 'ebs', qty: 60 }, { kind: 'alb', qty: 1 }, { kind: 's3', qty: 200 }, { kind: 'egress', qty: 400 }] },
    { name: 'Jaringan privat dengan NAT', items: [{ kind: 'ec2', type: 't3a.large', qty: 2 }, { kind: 'nat', qty: 1, gbProcessed: 200 }, { kind: 'ebs', qty: 100 }] },
  ];

  const typeOptions = (sel) => {
    const groups = { x86_64: 'x86_64 (Intel/AMD)', arm64: 'arm64 (Graviton)' };
    return Object.entries(groups)
      .map(([arch, label]) => `<optgroup label="${esc(label)}">${cat.instances.filter((i) => i.arch === arch).map((i) => `<option value="${esc(i.type)}" ${i.type === sel ? 'selected' : ''}>${esc(i.type)}: ${i.vcpu} vCPU, ${i.memGiB} GiB, ${usd(i.hourly, 4)}/jam</option>`).join('')}</optgroup>`)
      .join('');
  };

  function rowHtml(it, i) {
    const k = cat.kinds[it.kind];
    const type = it.kind === 'ec2' ? `<label>Tipe EC2<select data-f="type" data-i="${i}">${typeOptions(it.type)}</select></label>` : `<label>Jenis<input value="${esc(k.label)}" disabled></label>`;
    const extra = it.kind === 'nat' ? `<label>Data diproses (GB)<input type="number" min="0" step="any" data-f="gbProcessed" data-i="${i}" value="${esc(it.gbProcessed ?? 0)}"></label>` : '<span></span>';
    return `<div class="plan-row" data-row="${i}">
      ${type}${extra}
      <label>Jumlah (${esc(k.unit)})<input type="number" min="0" step="any" data-f="qty" data-i="${i}" value="${esc(it.qty)}"></label>
      <button class="btn small danger" type="button" data-rm="${i}" aria-label="Hapus baris ${esc(k.label)}">Hapus</button>
    </div>`;
  }

  function outHtml(r) {
    if (!r) return '<p class="muted">Tambahkan sumber daya di sebelah kiri untuk melihat perkiraan biaya.</p>';
    const donut = C.donut({
      slices: r.rows.filter((x) => x.monthly > 0).map((x) => ({ label: `${x.label} (${x.detail})`, value: x.monthly })),
      label: 'Porsi biaya bulanan per sumber daya',
      center: { top: usd(r.monthly), bottom: 'per bulan' },
      size: 140,
    });
    const growth = C.line({ rows: r.growth.map((g) => ({ date: `Bulan ${g.month}`, v: g.cumulative })), label: 'Biaya kumulatif selama 12 bulan' });
    return `<div class="label muted">Perkiraan biaya per bulan</div>
      <div class="big">${usd(r.monthly)}</div>
      <p class="muted" style="margin:0 0 14px">${usd(r.monthly / 30.4, 2)} per hari, ${usd(r.yearly)} per tahun.</p>
      ${donut}
      <h3 style="margin:16px 0 6px">Biaya kumulatif 12 bulan</h3>${growth}
      <div class="tbl-wrap" tabindex="0" style="margin-top:12px"><table><thead><tr><th scope="col">Sumber daya</th><th scope="col">Rincian</th><th scope="col" class="num">Per bulan</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.detail)}</td><td class="num">${usd(x.monthly)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="margin-top:10px">Harga daftar AWS ${esc(cat.region.code)} on-demand (730 jam per bulan). Server EC2 sudah termasuk satu alamat IPv4 publik. Harga bisa berubah, jadi cek ulang di halaman harga AWS sebelum dipakai untuk keputusan.</p>`;
  }

  async function calc(main) {
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

  function renderRows(main) {
    $('#planRows').innerHTML = items.length ? items.map(rowHtml).join('') : '<p class="muted">Belum ada baris. Pilih sumber daya di bawah, atau mulai dari contoh.</p>';
    $('#planRows').querySelectorAll('[data-f]').forEach((el) =>
      el.addEventListener('input', () => {
        const i = Number(el.dataset.i);
        items[i][el.dataset.f] = el.dataset.f === 'type' ? el.value : Number(el.value);
        calc(main);
      })
    );
    $('#planRows').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.rm), 1); renderRows(main); calc(main); }));
  }

  function csv() {
    if (!lastCalc) return;
    const lines = ['Sumber daya,Rincian,Per bulan (USD)', ...lastCalc.rows.map((r) => `"${r.label}","${r.detail}",${r.monthly.toFixed(2)}`), `Total,,${lastCalc.monthly.toFixed(2)}`];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rencana-biaya.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function savedHtml() {
    const list = cat.savedPlans;
    if (!list.length) return '<p class="muted">Belum ada rencana tersimpan. Simpan rencana di atas untuk membandingkannya nanti.</p>';
    const max = Math.max(...list.map((p) => p.monthly), 1);
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Nama</th><th scope="col">Dibuat</th><th scope="col" class="num">Per bulan</th><th scope="col">Perbandingan</th><th scope="col">Aksi</th></tr></thead><tbody>${list
      .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(A.fmtTime(p.ts))}</td><td class="num">${usd(p.monthly)}</td><td style="min-width:140px"><div class="meter" style="max-width:none"><span style="width:${(p.monthly / max) * 100}%"></span></div></td><td><div class="row"><button class="btn small" type="button" data-load="${esc(p.id)}">Muat</button><button class="btn small danger" type="button" data-del="${esc(p.id)}">Hapus</button></div></td></tr>`)
      .join('')}</tbody></table></div>`;
  }

  async function render(main) {
    cat = await api('GET', '/api/plan/catalog');
    const add = Object.entries(cat.kinds).map(([k, v]) => `<button class="btn small" type="button" data-add="${k}">${esc(v.label)}</button>`).join('');
    const body = `<div class="note" style="display:flex;gap:12px;align-items:flex-start">${L.badge('plan', 'logo')}<div><b>Mode perencanaan tidak memakai server asli dan tidak mengeluarkan uang.</b> Susun daftar sumber daya, lihat perkiraan biaya bulanan dan tahunan, lalu bandingkan beberapa rencana. Hasilnya tidak mengubah anggaran, forecast, atau riwayat biaya.</div></div>
      <div class="plan">
        <div>
          <h2>Sumber daya</h2>
          <div class="preset-row" id="presets"><span class="muted" style="align-self:center">Mulai dari contoh:</span>${PRESETS.map((p, i) => `<button class="btn small" type="button" data-preset="${i}">${esc(p.name)}</button>`).join('')}</div>
          <div class="plan-rows" id="planRows"></div>
          <div class="add-menu" id="addMenu"><span class="muted" style="align-self:center">Tambah:</span>${add}</div>
          <form id="saveForm" class="row end" style="margin-top:18px"><label>Nama rencana<input id="planName" maxlength="80" placeholder="Misalnya: Produksi tahap 1" style="width:240px"></label><button class="btn primary" type="submit">Simpan rencana</button><button class="btn" type="button" id="dlPlan">Unduh CSV</button></form>
        </div>
        <aside class="plan-out" id="planOut" aria-live="polite"></aside>
      </div>
      <section class="section" style="margin-top:28px"><h2>Rencana tersimpan</h2><div id="savedHost">${savedHtml()}</div></section>`;
    main.innerHTML = pageHtml('Perencanaan', '<span class="muted">Hitung biaya sebelum membuat apa pun</span>', body);

    if (!items.length) items = JSON.parse(JSON.stringify(PRESETS[0].items));
    renderRows(main);
    calc(main);

    main.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        const kind = b.dataset.add;
        items.push(kind === 'ec2' ? { kind, type: 't3a.small', qty: 1 } : kind === 'nat' ? { kind, qty: 1, gbProcessed: 100 } : { kind, qty: kind === 'ebs' ? 30 : kind === 's3' ? 100 : kind === 'egress' ? 200 : 1 });
        if (items.length > 50) items.pop();
        renderRows(main);
        calc(main);
      })
    );
    main.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { items = JSON.parse(JSON.stringify(PRESETS[Number(b.dataset.preset)].items)); renderRows(main); calc(main); }));
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
    const bindSaved = () => {
      main.querySelectorAll('[data-load]').forEach((b) =>
        b.addEventListener('click', () => {
          const p = cat.savedPlans.find((x) => x.id === b.dataset.load);
          if (!p) return;
          items = JSON.parse(JSON.stringify(p.items));
          $('#planName').value = p.name;
          renderRows(main);
          calc(main);
          window.scrollTo?.({ top: 0 });
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
    };
    bindSaved();
  }

  window.Pages.plan = render;
})();
