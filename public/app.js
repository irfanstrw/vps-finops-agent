'use strict';
(() => {
  // ---------- utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Escape dulu, baru terapkan **tebal** dan `kode`. Aman karena markup ditambahkan setelah escape.
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const usd = (n, d = 2) => {
    if (n == null || !Number.isFinite(n)) return '-';
    const a = Math.abs(n);
    return (n < 0 ? '-$' : '$') + a.toFixed(a > 0 && a < 0.01 && d < 3 ? 6 : d);
  };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('id-ID') : '-');
  const ago = (ts) => {
    if (!ts) return 'belum pernah';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s} dtk lalu`;
    if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
    if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
    return `${Math.round(s / 86400)} hari lalu`;
  };

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/login') {
      showLogin();
      throw new Error('Not signed in');
    }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const o = btn.textContent;
      btn.textContent = 'Tersalin';
      setTimeout(() => (btn.textContent = o), 1500);
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copy(b.closest('.copy-wrap').querySelector('pre').textContent, b);
  });
  const codeBox = (text) => `<div class="copy-wrap"><button class="btn small" type="button" data-copy>Salin</button><pre>${esc(text)}</pre></div>`;

  // Konfirmasi di tempat, tanpa popup browser.
  function confirmInline(btn, question, yesLabel, onYes) {
    if (btn.dataset.confirming) return;
    btn.dataset.confirming = '1';
    btn.classList.add('hidden');
    const box = document.createElement('span');
    box.className = 'confirm-inline';
    box.setAttribute('role', 'group');
    box.innerHTML = `<span>${esc(question)}</span><button class="btn small danger" type="button" data-yes>${esc(yesLabel)}</button><button class="btn small" type="button" data-no>Batal</button>`;
    btn.after(box);
    box.querySelector('[data-no]').focus();
    const close = () => {
      box.remove();
      btn.classList.remove('hidden');
      delete btn.dataset.confirming;
      btn.focus();
    };
    box.querySelector('[data-no]').addEventListener('click', close);
    box.querySelector('[data-yes]').addEventListener('click', async () => {
      box.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await onYes();
        // Berhasil: bersihkan kotak konfirmasi. Tombol aslinya dikembalikan hanya kalau masih relevan
        // (kalau elemennya sudah dibuang atau disembunyikan oleh halaman, biarkan apa adanya).
        box.remove();
        delete btn.dataset.confirming;
        if (btn.isConnected && !btn.dataset.keepHidden) btn.classList.remove('hidden');
      } catch (err) {
        toast(err.message);
        close();
      }
    });
  }

  // ---------- dialog ----------
  let pollTimer = null;
  let modalOpener = null;
  function openModal(html) {
    modalOpener = document.activeElement;
    $('#modalCard').innerHTML = html;
    $('#modal').classList.remove('hidden');
    const first = $('#modalCard input, #modalCard select, #modalCard textarea');
    (first || $('#modalCard')).focus();
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalCard').innerHTML = '';
    if (pollTimer) clearInterval(pollTimer);
    if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
    modalOpener = null;
  }
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    const open = !$('#modal').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (open) closeModal();
      else if ($('#app').classList.contains('nav-open')) setNav(false);
      return;
    }
    if (e.key === 'Tab' && open) {
      const items = [...$('#modalCard').querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex="0"]')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === $('#modalCard'))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- masuk dan tema ----------
  function showLogin() {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#password').focus();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      await api('POST', '/api/login', { password: $('#password').value });
      $('#password').value = '';
      boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    showLogin();
  });

  function applyTheme() {
    const light = localStorage.theme === 'light';
    document.body.classList.toggle('light', light);
    $('#themeBtn').textContent = light ? 'Mode gelap' : 'Mode terang';
  }
  $('#themeBtn').addEventListener('click', () => {
    localStorage.theme = document.body.classList.contains('light') ? 'dark' : 'light';
    applyTheme();
    if (location.hash.startsWith('#/overview')) router();
  });
  applyTheme();

  // Logo produk di header dan halaman masuk (skrip logos.js dimuat sebelum file ini).
  if (window.Logos) {
    $('#brandLogo').innerHTML = window.Logos.product('logo');
    $('#loginLogo').innerHTML = window.Logos.product('logo');
  }

  // ---------- kerangka ----------
  let chats = [];
  function setNav(open) {
    $('#app').classList.toggle('nav-open', open);
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    if (!open) $('#menuBtn').focus({ preventScroll: true });
  }
  $('#menuBtn').addEventListener('click', () => setNav(!$('#app').classList.contains('nav-open')));
  $('#scrim').addEventListener('click', () => setNav(false));
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('a, #newChatBtn') && $('#app').classList.contains('nav-open')) $('#app').classList.remove('nav-open');
  });
  $('#skip').addEventListener('click', (e) => {
    e.preventDefault();
    $('#main').focus();
  });

  async function refreshRecent() {
    chats = await api('GET', '/api/chats');
    const cur = location.hash.match(/^#\/chat\/(\w+)/)?.[1];
    $('#recent').innerHTML = chats.length
      ? chats.map((c) => `<a href="#/chat/${esc(c.id)}" ${c.id === cur ? 'aria-current="page"' : ''} title="${esc(c.title)}">${esc(c.title)}</a>`).join('')
      : '<span class="muted" style="padding:0 10px">Belum ada percakapan</span>';
    // Tombol "Hapus semua" hanya ada kalau ada percakapan. Konfirmasi yang sedang terbuka ikut hilang bila daftar kosong.
    const clear = $('#clearChats');
    if (chats.length) delete clear.dataset.keepHidden;
    clear.classList.toggle('hidden', !chats.length || !!clear.dataset.confirming);
    if (!chats.length) {
      $('#sidebar .confirm-inline')?.remove();
      delete clear.dataset.confirming;
    }
  }
  $('#clearChats').addEventListener('click', (e) =>
    confirmInline(e.currentTarget, 'Yakin ingin hapus?', 'Ya, hapus semua', async () => {
      await api('DELETE', '/api/chats');
      toast('Semua percakapan dihapus');
      chats = [];
      $('#recent').innerHTML = '<span class="muted" style="padding:0 10px">Belum ada percakapan</span>';
      $('#clearChats').dataset.keepHidden = '1';
      $('#clearChats').classList.add('hidden');
      if (location.hash === '#/chat/new') router();
      else location.hash = '#/chat/new';
    })
  );
  async function refreshBalance() {
    try {
      const o = await api('GET', '/api/overview');
      $('#balancePill').innerHTML = `Saldo <b>${esc(usd(o.balance.remaining))}</b>`;
      return o;
    } catch {
      return null;
    }
  }
  $('#newChatBtn').addEventListener('click', () => {
    if (location.hash === '#/chat/new') router();
    else location.hash = '#/chat/new';
  });

  const TITLES = { chat: 'Chat', overview: 'Ringkasan', plan: 'Perencanaan', tasks: 'Tasks', automations: 'Automations', artifacts: 'Artifacts', context: 'Context files', integrations: 'Integrations' };
  function setActiveNav(name) {
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async function router() {
    if (pollTimer) clearInterval(pollTimer);
    const h = location.hash || '#/chat/new';
    const [, page, id] = h.match(/^#\/(\w+)(?:\/(\w+))?/) || [];
    setActiveNav(page);
    document.title = `${TITLES[page] || 'Chat'} | VPS FinOps Agent`;
    const main = $('#main');
    main.innerHTML = '<div class="page"><p class="muted" role="status">Memuat…</p></div>';
    try {
      if (page === 'chat') await renderChat(main, id);
      else if (window.Pages?.[page]) await window.Pages[page](main, id);
      else if (page === 'overview') await renderOverview(main);
      else if (page === 'tasks') await renderTasks(main);
      else if (page === 'automations') await renderAutomations(main);
      else if (page === 'artifacts') await renderArtifacts(main, id);
      else if (page === 'context') await renderContext(main);
      else if (page === 'integrations') await renderIntegrations(main, id);
      else {
        location.hash = '#/chat/new';
        return;
      }
      if (page !== 'chat') main.focus({ preventScroll: true });
    } catch (e) {
      if (e.message === 'Not signed in') return;
      main.innerHTML = `<div class="page"><h1>Halaman tidak bisa dimuat</h1><p class="err" role="alert">${esc(e.message)}</p>
        <p class="muted">Cek koneksi internet, lalu coba lagi.</p><button class="btn" type="button" id="retry">Coba lagi</button></div>`;
      $('#retry').addEventListener('click', router);
    }
    refreshRecent().catch(() => {});
  }
  window.addEventListener('hashchange', router);

  const pageHtml = (title, actions, body) => `<div class="page"><div class="page-head"><h1>${title}</h1>${actions || ''}</div>${body}</div>`;

  // ---------- balasan agent ----------
  function renderReply(r) {
    const blocks = r.blocks.map((b) => {
      if (b.type === 'p') return `<p>${md(b.text)}</p>`;
      if (b.type === 'h') return `<h2>${md(b.text)}</h2>`;
      if (b.type === 'ul') return `<ul>${b.items.map((i) => `<li>${md(i)}</li>`).join('')}</ul>`;
      if (b.type === 'stats') return `<div class="stats">${b.items.map((s) => `<div class="stat"><div class="sv">${esc(s.value)}</div><div class="sl">${esc(s.label)}</div></div>`).join('')}</div>`;
      if (b.type === 'follow') return `<div class="followups" role="group" aria-label="Pertanyaan lanjutan">${b.items.map((q) => `<button class="btn small" type="button" data-suggest="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
      if (b.type === 'chart' && window.Charts) {
        const C = window.Charts;
        let g = '';
        if (b.kind === 'bars') g = C.bars({ rows: b.rows.map((r) => ({ ...r, label: String(r.date).slice(5) })), series: b.series, label: b.title, height: 170 });
        else if (b.kind === 'line') g = C.line({ rows: b.rows.map((r) => ({ ...r })), label: b.title, height: 170, refLine: b.ref?.value, refLabel: b.ref?.label });
        else if (b.kind === 'donut') g = C.donut({ slices: b.slices, label: b.title, size: 130 });
        return g ? `<figure class="blk"><figcaption class="blk-title">${esc(b.title)}</figcaption>${g}</figure>` : '';
      }
      if (b.type === 'table')
        return `<div class="tbl-wrap" tabindex="0"><table><thead><tr>${b.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
          .map((row) => `<tr>${row.map((c) => `<td>${md(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
      return '';
    });
    const steps = r.steps?.length
      ? `<details class="thinking"><summary>Lihat proses analisis (${r.steps.length} langkah)</summary><ol>${r.steps.map((s) => `<li>${md(s)}</li>`).join('')}</ol></details>`
      : '';
    queueMicrotask(() => window.Charts && window.Charts.bind(document));
    return `<div class="reply">${steps}${blocks.join('')}</div>`;
  }

  // ---------- chat ----------
  const SUGGESTIONS = [
    'Cek anomali biaya 7 hari terakhir',
    'Tampilkan biaya 30 hari terakhir',
    'Forecast bulan ini',
    'Rekomendasi rightsizing',
    'Berapa saldo kredit saya?',
    'Status VPS',
  ];

  async function renderChat(main, id) {
    let chat = null;
    if (id && id !== 'new') chat = await api('GET', `/api/chats/${encodeURIComponent(id)}`);
    const headHtml = (c) => `<div class="chat-head"><h1>${esc(c.title)}<button class="link small" type="button" id="showId">Lihat ID</button></h1><button class="btn small danger" type="button" id="delChat">Hapus percakapan</button></div>`;
    main.innerHTML = `
      ${chat ? headHtml(chat) : ''}
      <div class="messages" id="messages" aria-live="polite"></div>
      <div class="composer">
        <form id="composer" class="composer-form">
          <label class="sr-only" for="input">Pertanyaan untuk FinOps Agent</label>
          <textarea id="input" maxlength="10000" placeholder="Tulis pertanyaan tentang biaya VPS"></textarea>
          <button class="btn primary" type="submit">Kirim</button>
        </form>
        <div class="meta"><span>Biaya dihitung dengan harga AWS us-east-1 on-demand. Periksa kembali rekomendasi sebelum dijalankan.</span><span id="count">0/10000 karakter</span></div>
      </div>`;
    const box = $('#messages');
    if (!chat || !chat.messages.length) {
      box.innerHTML = `<div class="empty"><h1>Tanyakan biaya VPS kamu</h1><p class="muted">Agent menjawab dari data biaya yang sudah terkumpul: pengeluaran, anomali, forecast, dan rightsizing. Belum ada VPS? Tambahkan dulu di Integrations.</p>
        <div class="suggest">${SUGGESTIONS.map((s) => `<button class="btn small" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    } else {
      box.innerHTML = chat.messages.map((m) => msgHtml(m, chat.id)).join('');
      box.scrollTop = box.scrollHeight;
    }
    const bindHead = () => {
      $('#showId').addEventListener('click', (e) => (e.target.textContent = chat.id));
      $('#delChat').addEventListener('click', (e) =>
        confirmInline(e.currentTarget, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('DELETE', `/api/chats/${chat.id}`);
          toast('Percakapan dihapus');
          if (location.hash === '#/chat/new') router();
          else location.hash = '#/chat/new';
        })
      );
    };
    if (chat) bindHead();

    const input = $('#input');
    input.addEventListener('input', () => ($('#count').textContent = `${input.value.length}/10000 karakter`));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#composer').requestSubmit();
      }
    });
    box.addEventListener('click', async (e) => {
      const s = e.target.closest('[data-suggest]');
      if (s) {
        input.value = s.dataset.suggest;
        $('#composer').requestSubmit();
      }
      const save = e.target.closest('[data-save]');
      if (save) {
        try {
          await api('POST', '/api/artifacts', { chatId: save.dataset.chat, messageId: save.dataset.save });
          toast('Tersimpan di Artifacts');
        } catch (err) {
          toast(err.message);
        }
      }
    });
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      try {
        if (!chat) {
          chat = await api('POST', '/api/chats');
          chat.messages = [];
          // Percakapan baru: pasang header (judul dan tombol hapus) tanpa memuat ulang halaman.
          main.insertAdjacentHTML('afterbegin', headHtml(chat));
          bindHead();
        }
        if (!chat.messages.length) box.innerHTML = '';
        box.insertAdjacentHTML('beforeend', msgHtml({ role: 'user', text, ts: Date.now() }));
        box.insertAdjacentHTML('beforeend', '<div class="msg agent" id="pending"><div class="who">FinOps Agent</div><div class="body muted">Menganalisis…</div></div>');
        box.scrollTop = box.scrollHeight;
        const r = await api('POST', `/api/chats/${chat.id}/messages`, { text });
        chat.messages.push(r.user, r.agent);
        $('#pending').outerHTML = msgHtml(r.agent, chat.id);
        box.scrollTop = box.scrollHeight;
        const h1 = $('.chat-head h1');
        if (h1 && r.chat?.title) h1.firstChild.textContent = r.chat.title;
        if (!location.hash.includes(chat.id)) history.replaceState(null, '', `#/chat/${chat.id}`);
        refreshRecent();
        refreshBalance();
      } catch (err) {
        $('#pending')?.remove();
        toast(err.message);
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
    input.focus();
  }

  function msgHtml(m, chatId) {
    if (m.role === 'user')
      return `<div class="msg user"><div class="bubble">${esc(m.text)}</div><div class="time">${esc(new Date(m.ts).toLocaleTimeString('id-ID', { hour: 'numeric', minute: '2-digit' }))}</div></div>`;
    const engine = m.engine && m.engine !== 'rule-based' ? `<span class="engine">${esc(m.engine.split(':').slice(1).join(':'))}</span>` : '';
    return `<div class="msg agent"><div class="who">FinOps Agent${engine}</div><div class="body">${renderReply(m.reply)}
      ${m.id && chatId ? `<div class="msg-actions"><button class="btn small" type="button" data-save="${esc(m.id)}" data-chat="${esc(chatId)}">Simpan sebagai artifact</button></div>` : ''}</div></div>`;
  }

  // ---------- ringkasan ----------
  // Riwayat (penuh) diikuti proyeksi (berpola). Data yang sama tersedia sebagai tabel di bawah grafik.
  function chartHtml(daily, projected = []) {
    const hasHistory = daily.some((d) => d.total > 0);
    const hasProj = projected.some((d) => d.total > 0);
    if (!hasHistory && !hasProj) {
      return '<p class="chart-empty">Belum ada data biaya. Hubungkan VPS lewat Connect VPS, atau tambah VPS sample AWS lalu klik Aktifkan proyeksi.</p>';
    }
    const hist = hasHistory ? daily : [];
    const all = [...hist, ...projected];
    const max = Math.max(...all.map((d) => d.total), 0.000001);
    const keys = ['compute', 'storage', 'ipv4', 'egress'];
    const bar = (d, cls) => {
      const segs = keys.map((k) => `<div class="seg c-${k}" style="height:${(d[k] / max) * 100}%"></div>`).join('');
      return `<div class="bar ${cls}" title="${esc(d.date)}${cls ? ' (proyeksi)' : ''}: ${esc(usd(d.total))}">${segs}</div>`;
    };
    const bars = [...hist.map((d) => bar(d, '')), ...(hasHistory && hasProj ? ['<div class="gap"></div>'] : []), ...projected.map((d) => bar(d, 'proj'))].join('');
    const label = `Biaya harian dari ${all[0].date} sampai ${all[all.length - 1].date}, tertinggi ${usd(max)} per hari${hasProj ? ', termasuk proyeksi' : ''}.`;
    const rows = all
      .map((d) => `<tr><td>${esc(d.date)}</td><td>${d.date > new Date().toISOString().slice(0, 10) ? 'proyeksi' : 'aktual'}</td><td class="num">${usd(d.compute)}</td><td class="num">${usd(d.storage)}</td><td class="num">${usd(d.ipv4)}</td><td class="num">${usd(d.egress)}</td><td class="num">${usd(d.total)}</td></tr>`)
      .join('');
    return `<div class="chart" role="img" aria-label="${esc(label)}">${bars}</div>
      <div class="chart-x"><span>${esc(all[0].date)}</span><span>tertinggi ${esc(usd(max))}/hari</span><span>${esc(all[all.length - 1].date)}</span></div>
      <div class="legend"><span><i class="c-compute"></i>EC2 compute</span><span><i class="c-storage"></i>EBS gp3</span><span><i class="c-ipv4"></i>Public IPv4</span><span><i class="c-egress"></i>Data transfer out</span>${hasProj ? '<span>Batang berpola: proyeksi</span>' : ''}</div>
      <details class="data"><summary>Lihat data dalam tabel</summary><div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">Jenis</th><th scope="col" class="num">EC2</th><th scope="col" class="num">EBS</th><th scope="col" class="num">IPv4</th><th scope="col" class="num">Transfer</th><th scope="col" class="num">Total</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  }

  async function renderOverview(main) {
    const o = await refreshBalance();
    if (!o) throw new Error('Data ringkasan tidak bisa diambil');
    const budget = o.budget?.amount || 0;
    const fc = o.forecast.forecast;
    const pct = budget ? (fc / budget) * 100 : 0;
    const budgetHtml = budget
      ? `<div class="meter ${pct > 100 ? 'over' : ''}" role="img" aria-label="Forecast ${pct.toFixed(0)} persen dari budget"><span style="width:${Math.min(100, pct)}%"></span></div>
         <p class="sub">${pct > 100 ? `Melebihi budget ${usd(budget)} sekitar ${usd(fc - budget)}.` : `${pct.toFixed(0)}% dari budget ${usd(budget)}.`} Sumber budget: ${esc(o.budget.source)}.</p>`
      : '<p class="sub">Budget belum diatur. Isi di Automations (Peringatan budget bulanan) atau lewat baris <code>budget: 30</code> di Context files.</p>';

    const body = `
      <div class="summary">
        <div class="focus">
          <div class="label">Forecast biaya bulan ini</div>
          <div class="big">${usd(fc)}</div>
          ${budgetHtml}
        </div>
        <dl class="facts">
          <div><dt>Saldo kredit</dt><dd>${usd(o.balance.remaining)}<small>dari total ${usd(o.balance.credit)}</small></dd></div>
          <div><dt>Terpakai bulan ${esc(o.mtd.month)}</dt><dd>${usd(o.mtd.total)}</dd></div>
          <div><dt>Run rate saat ini</dt><dd>${usd(o.forecast.runRatePerHour * 24)}/hari<small>${usd(o.forecast.runRatePerHour, 4)}/jam</small></dd></div>
        </dl>
      </div>
      <section class="section"><h2>Biaya harian: 30 hari terakhir dan proyeksi 30 hari ke depan</h2>${chartHtml(o.daily, o.projected)}</section>
      <section class="section"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">VPS</h2><a href="#/integrations">Kelola di Integrations</a></div>
        ${o.vps.length ? vpsTable(o.vps) : '<p class="muted">Belum ada VPS. Hubungkan server lewat <a href="#/integrations">Integrations</a> untuk mulai menghitung biaya.</p>'}</section>
      <section class="section"><h2>Anomali, 30 hari terakhir</h2>
        ${o.anomalies.length
          ? `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">VPS</th><th scope="col">Service</th><th scope="col" class="num">Perkiraan</th><th scope="col" class="num">Aktual</th><th scope="col" class="num">Dampak</th></tr></thead><tbody>${o.anomalies
              .map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.vpsName)}</td><td>${esc(a.service)}</td><td class="num">${usd(a.expected)}</td><td class="num">${usd(a.actual)}</td><td class="num">${usd(a.impact)}</td></tr>`)
              .join('')}</tbody></table></div>`
          : '<p class="muted">Tidak ada lonjakan biaya yang melewati 1,5x baseline 14 hari.</p>'}
      </section>
      <section class="section"><h2>Tambah saldo kredit</h2>
        <form id="topup" class="row end"><label>Jumlah (USD)<input type="number" min="1" max="100000" step="1" value="100" id="topupAmt" required></label><button class="btn" type="submit">Tambah saldo</button></form>
      </section>`;
    main.innerHTML = pageHtml('Ringkasan', `<span class="muted">Harga ${esc(o.region.name)} (${esc(o.region.code)})</span>`, body);
    $('#topup').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/settings/topup', { amount: Number($('#topupAmt').value) });
        toast('Saldo ditambahkan');
        renderOverview(main);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  const STATUS = { online: 'online', offline: 'offline', pending: 'menunggu agent' };
  function vpsTable(list, actions = false) {
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Nama</th><th scope="col">Status</th><th scope="col">Host / OS</th><th scope="col">Spesifikasi</th><th scope="col">Setara EC2</th><th scope="col" class="num">$/jam</th><th scope="col" class="num">Biaya bulan ini</th><th scope="col">Terakhir aktif</th>${actions ? '<th scope="col">Aksi</th>' : ''}</tr></thead><tbody>
      ${list
        .map((v) => {
          const l = v.last;
          const st = v.demo ? (v.active ? ['proyeksi aktif', 'aktif'] : ['sample', 'sample']) : [STATUS[v.status] || v.status, v.status];
          return `<tr>
            <td>${esc(v.name)}</td>
            <td><span class="status s-${esc(st[1])}">${esc(st[0])}</span></td>
            <td>${v.demo ? '<span class="muted">sample AWS</span>' : l ? `${esc(l.hostname)}<br><span class="muted">${esc(l.os)}</span>` : '-'}</td>
            <td>${l ? `${esc(l.vcpu)} vCPU, ${esc(l.memTotalGiB.toFixed(1))} GiB, ${esc(l.diskTotalGB.toFixed(0))} GB` : '-'}</td>
            <td>${v.instanceType ? `<code>${esc(v.instanceType)}</code>` : '-'}</td>
            <td class="num">${v.hourly ? usd(v.hourly, 4) : '-'}</td>
            <td class="num">${v.demo ? `${usd(v.projectedMonthly)}/bln<br><span class="muted">proyeksi</span>` : usd(v.mtd)}</td>
            <td>${v.demo ? '-' : esc(ago(v.lastSeen))}</td>
            ${actions ? `<td><div class="row">${
              v.demo
                ? `<button class="btn small ${v.active ? '' : 'primary'}" type="button" data-active="${esc(v.id)}" data-on="${v.active ? '0' : '1'}">${v.active ? 'Nonaktifkan proyeksi' : 'Aktifkan proyeksi'}</button>`
                : `<button class="btn small" type="button" data-rotate="${esc(v.id)}">Token baru</button>`
            }<button class="btn small danger" type="button" data-del="${esc(v.id)}">Hapus</button></div></td>` : ''}
          </tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  // ---------- tasks ----------
  const TASK_STATUS = { ok: 'Selesai', alert: 'Perlu dicek', failed: 'Gagal' };
  async function renderTasks(main) {
    const tasks = await api('GET', '/api/tasks');
    const body = tasks.length
      ? `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Waktu</th><th scope="col">Task</th><th scope="col">Pemicu</th><th scope="col">Status</th><th scope="col">Ringkasan</th><th scope="col">Hasil</th></tr></thead><tbody>${tasks
          .map(
            (t) => `<tr><td>${esc(fmtTime(t.ts))}</td><td>${esc(t.name)}</td><td>${esc(t.trigger)}</td><td><span class="status s-${esc(t.status)}">${esc(TASK_STATUS[t.status] || t.status)}</span></td><td>${esc(t.summary)}</td>
              <td>${t.chatId ? `<a href="#/chat/${esc(t.chatId)}">Buka chat</a>` : t.artifactId ? `<a href="#/artifacts/${esc(t.artifactId)}">Buka laporan</a>` : ''}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      : '<p class="muted">Belum ada task. Task muncul setiap kali kamu bertanya di chat atau sebuah automation berjalan.</p>';
    main.innerHTML = pageHtml('Tasks', '<span class="muted">Semua permintaan chat dan eksekusi automation</span>', body);
  }

  // ---------- automations ----------
  async function renderAutomations(main) {
    const list = await api('GET', '/api/automations');
    const body = list
      .map(
        (a) => `<section class="box" data-id="${esc(a.id)}">
          <div class="page-head"><h2 style="margin:0">${esc(a.name)}</h2>
            <label class="row" style="gap:10px">Aktif<span class="switch"><input type="checkbox" data-toggle ${a.enabled ? 'checked' : ''}><span></span></span></label></div>
          <p class="muted">${esc(a.description)}</p>
          <div class="row end">
            <label>Jalankan setiap (jam)<input type="number" min="1" max="720" value="${esc(a.intervalHours)}" data-interval style="width:120px"></label>
            ${a.type === 'budget' ? `<label>Budget bulanan (USD)<input type="number" min="0" step="1" value="${esc(a.params.monthlyBudgetUsd)}" data-budget style="width:140px"></label>` : ''}
            <button class="btn" type="button" data-savea>Simpan</button>
            <button class="btn primary" type="button" data-run>Jalankan sekarang</button>
          </div>
          <p class="muted" style="margin:10px 0 0">Terakhir dijalankan: ${esc(fmtTime(a.lastRun))}${a.lastResult ? `. Hasil: <span class="${a.lastResult.alert ? 's-alert' : 's-ok'}">${esc(a.lastResult.summary)}</span>` : ''}</p>
        </section>`
      )
      .join('');
    main.innerHTML = pageHtml('Automations', '<span class="muted">Dijalankan otomatis saat jatuh tempo. Hasilnya masuk ke Tasks dan Artifacts.</span>', body);
    main.querySelectorAll('section[data-id]').forEach((sec) => {
      const id = sec.dataset.id;
      $('[data-toggle]', sec).addEventListener('change', async (e) => {
        await api('PATCH', `/api/automations/${id}`, { enabled: e.target.checked }).catch((err) => toast(err.message));
      });
      $('[data-savea]', sec).addEventListener('click', async () => {
        const body = { intervalHours: Number($('[data-interval]', sec).value) };
        const b = $('[data-budget]', sec);
        if (b) body.monthlyBudgetUsd = Number(b.value);
        try {
          await api('PATCH', `/api/automations/${id}`, body);
          toast('Tersimpan');
        } catch (err) {
          toast(err.message);
        }
      });
      $('[data-run]', sec).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('POST', `/api/automations/${id}/run`);
          toast(r.result.summary);
          renderAutomations(main);
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      });
    });
  }

  // ---------- artifacts ----------
  async function renderArtifacts(main, id) {
    if (id) return renderArtifactDetail(main, id);
    return window.Pages.artifacts(main);
  }
  async function renderArtifactDetail(main, id) {
    {
      const a = await api('GET', `/api/artifacts/${encodeURIComponent(id)}`);
      main.innerHTML = pageHtml(
        esc(a.title),
        '<div class="row"><a class="btn small" href="#/artifacts" style="display:inline-flex;align-items:center;text-decoration:none">Kembali</a><button class="btn small" type="button" id="dl">Unduh JSON</button><button class="btn small danger" type="button" id="delA">Hapus</button></div>',
        `<div class="box">${renderReply(a.reply)}</div>`
      );
      $('#dl').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `artifact-${a.id}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
      });
      $('#delA').addEventListener('click', (e) =>
        confirmInline(e.currentTarget, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('DELETE', `/api/artifacts/${a.id}`);
          location.hash = '#/artifacts';
        })
      );
    }
  }

  // ---------- context files ----------
  async function renderContext(main) {
    const list = await api('GET', '/api/context-files');
    const body = `
      <div class="box"><p class="muted">Catatan yang bisa dipakai agent. Baris seperti <code>budget: 30</code> mengatur budget bulanan untuk forecast dan menggantikan nilai di automation budget.</p>
        <form id="ctxForm" style="display:grid;gap:10px;max-width:640px">
          <label>Nama file<input id="ctxName" placeholder="budget.txt" maxlength="200" required></label>
          <label>Isi<textarea id="ctxContent" rows="5" placeholder="budget: 30" required></textarea></label>
          <div class="row"><button class="btn primary" type="submit">Tambah context file</button><label class="btn small" style="display:inline-flex;align-items:center;color:var(--text)">Unggah dari file<input type="file" id="ctxFile" accept=".txt,.md,.json,.csv,.yaml,.yml" class="sr-only"></label></div>
        </form></div>
      ${list
        .map(
          (f) => `<section class="box"><div class="page-head"><h2 style="margin:0">${esc(f.name)}</h2><button class="btn small danger" type="button" data-delctx="${esc(f.id)}">Hapus</button></div>
          <pre>${esc(f.content)}</pre></section>`
        )
        .join('')}`;
    main.innerHTML = pageHtml('Context files', '', body);
    $('#ctxFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 100000) return toast('File terlalu besar (maks 100 KB)');
      $('#ctxName').value = f.name;
      $('#ctxContent').value = await f.text();
    });
    $('#ctxForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/context-files', { name: $('#ctxName').value, content: $('#ctxContent').value });
        renderContext(main);
      } catch (err) {
        toast(err.message);
      }
    });
    main.querySelectorAll('[data-delctx]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmInline(b, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('DELETE', `/api/context-files/${b.dataset.delctx}`);
          renderContext(main);
        })
      )
    );
  }

  // ---------- integrations ----------
  async function renderIntegrations(main, tab) {
    tab = ['ai', 'aws', 'azure', 'gcp'].includes(tab) ? tab : 'vps';
    const cur = (t) => (tab === t ? 'aria-current="page"' : '');
    const tabs = `<nav class="tabs" aria-label="Integrations"><a href="#/integrations/vps" ${cur('vps')}>VPS</a><a href="#/integrations/aws" ${cur('aws')}>AWS</a><a href="#/integrations/azure" ${cur('azure')}>Azure</a><a href="#/integrations/gcp" ${cur('gcp')}>Google Cloud</a><a href="#/integrations/ai" ${cur('ai')}>AI Model</a></nav>`;
    if (tab === 'ai') return renderAi(main, tabs);
    if (tab === 'aws' || tab === 'azure' || tab === 'gcp') return window.App.renderCloudTab(main, tabs, tab);

    const [list, p] = await Promise.all([api('GET', '/api/vps'), api('GET', '/api/pricing')]);
    const origin = location.origin;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const body = `${tabs}
      <p class="muted">Agent membaca pemakaian CPU, RAM, disk, dan network dari VPS. Pemakaian itu dihitung dengan harga instance EC2 yang setara spesifikasinya di ${esc(p.region.name)}, lalu dipotong dari saldo kredit. VPS sample AWS tidak punya riwayat: biayanya berupa proyeksi, dan baru masuk forecast setelah diaktifkan.</p>

      <section class="section"><h2>VPS terdaftar</h2>
        ${list.length ? vpsTable(list, true) : '<p class="muted">Belum ada VPS. Klik Connect VPS untuk server asli, atau Tambah VPS sample AWS untuk melihat proyeksi biaya tipe EC2 tertentu.</p>'}</section>

      <section class="section"><h2>Cara menghubungkan VPS</h2>
        <ol class="steps">
          <li><b>Siapkan VPS.</b> Butuh Linux dengan systemd (Ubuntu, Debian, CentOS, Rocky), <code>bash</code>, <code>curl</code>, dan user dengan akses <code>sudo</code>. Cek di VPS:${codeBox('systemctl --version | head -1; curl --version | head -1; sudo -v && echo sudo-ok')}</li>
          <li><b>Pastikan VPS bisa menjangkau dashboard ini.</b> Agent mengirim data keluar dari VPS ke alamat dashboard, jadi VPS tidak perlu membuka port.
            ${isLocal ? `<div class="note">Dashboard sedang dibuka lewat <code>${esc(origin)}</code>, yang hanya bisa dijangkau dari komputer ini. Buka dashboard lewat alamat publiknya, atau atur <code>PUBLIC_URL</code> saat menjalankan server.</div>` : ''}
            Tes dari VPS. Hasilnya harus <code>{"authed":false}</code>:${codeBox(`curl -sS ${origin}/api/me`)}
            Kalau perintahnya timeout, cek firewall, VPN, atau proxy kampus. Kalau butuh proxy, tambahkan <code>--proxy http://proxy:port</code> di langkah 4.</li>
          <li><b>Klik Connect VPS</b> lalu beri nama, misalnya <code>ugm-vps-1</code>. Kamu mendapat token dan perintah install. Token hanya ditampilkan sekali.</li>
          <li><b>Jalankan perintah install di VPS lewat SSH.</b> Script akan memasang agent di <code>/usr/local/bin/finops-agent</code>, menyimpan token di <code>/etc/finops-agent.env</code> (mode 600), membuat systemd service <code>finops-agent</code> yang berjalan tanpa hak root dan hanya membaca, lalu mengirim satu laporan tes. Script bisa dibaca dulu: <a href="/agent/install.sh" target="_blank" rel="noopener">install.sh</a> dan <a href="/agent/finops-agent.sh" target="_blank" rel="noopener">finops-agent.sh</a>.</li>
          <li><b>Tunggu status menjadi online.</b> Jendela install berubah sendiri setelah laporan pertama masuk. Biaya mulai dihitung dari laporan kedua, dengan satu laporan setiap 60 detik.</li>
          <li><b>Tanyakan ke agent</b>, misalnya "Status VPS" atau "Forecast bulan ini".</li>
        </ol>
      </section>

      <section class="section"><h2>Kalau tidak tersambung</h2>
        <p>Status service dan log di VPS:</p>${codeBox('systemctl status finops-agent --no-pager\njournalctl -u finops-agent -n 50 --no-pager')}
        <p style="margin-top:12px">Kirim satu laporan secara manual:</p>${codeBox("sudo bash -c 'set -a; . /etc/finops-agent.env; set +a; /usr/local/bin/finops-agent --once'")}
        <ul>
          <li><b>401 atau token ditolak:</b> klik Token baru di baris VPS, lalu jalankan ulang perintah install yang muncul.</li>
          <li><b>Cannot reach:</b> alamat dashboard tidak terjangkau dari VPS. Cek firewall, VPN, atau tambahkan <code>--proxy</code>.</li>
          <li><b>Status offline:</b> tidak ada laporan selama 3 menit atau lebih. Jeda lebih dari 5 menit tidak dihitung biayanya.</li>
          <li><b>Alamat dashboard berganti:</b> jalankan ulang perintah install dengan alamat baru.</li>
        </ul>
        <p>Lepas agent dari VPS:</p>${codeBox(`curl -fsSL ${origin}/agent/uninstall.sh | sudo bash`)}
      </section>

      <section class="section"><h2>Harga yang dipakai (AWS ${esc(p.region.code)}, Linux on-demand)</h2>
        <ul>
          <li>EC2: instance dengan vCPU dan RAM yang paling pas dengan VPS, arsitektur CPU sama (x86_64 atau arm64).</li>
          <li>EBS gp3: ${usd(p.ebsGp3)} per GB-bulan, dari total ukuran disk.</li>
          <li>Public IPv4: ${usd(p.ipv4Hourly, 3)} per jam.</li>
          <li>Data transfer out: ${esc(p.egressFreeGB)} GB per bulan pertama gratis, selanjutnya ${usd(p.egressPerGB)} per GB.</li>
        </ul>
        <details><summary>Daftar harga instance</summary><div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Instance</th><th scope="col">Arsitektur</th><th scope="col" class="num">vCPU</th><th scope="col" class="num">RAM (GiB)</th><th scope="col" class="num">$/jam</th><th scope="col" class="num">$/bulan</th></tr></thead><tbody>
          ${p.instances.map((i) => `<tr><td><code>${esc(i.type)}</code></td><td>${esc(i.arch)}</td><td class="num">${esc(i.vcpu)}</td><td class="num">${esc(i.memGiB)}</td><td class="num">${usd(i.hourly, 4)}</td><td class="num">${usd(i.hourly * 730)}</td></tr>`).join('')}
        </tbody></table></div></details>
      </section>`;
    main.innerHTML = pageHtml('Integrations', '<div class="row"><button class="btn" type="button" id="sampleBtn">Tambah VPS sample AWS</button><button class="btn primary" type="button" id="connectBtn">Connect VPS</button></div>', body);

    $('#connectBtn').addEventListener('click', () => connectDialog(main));
    $('#sampleBtn').addEventListener('click', () => sampleDialog(main, p, list));
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmInline(b, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('DELETE', `/api/vps/${b.dataset.del}`);
          toast('VPS dihapus');
          renderIntegrations(main, 'vps');
          refreshBalance();
        })
      )
    );
    main.querySelectorAll('[data-active]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api('PATCH', `/api/vps/${b.dataset.active}`, { active: b.dataset.on === '1' });
          toast(b.dataset.on === '1' ? 'Proyeksi diaktifkan' : 'Proyeksi dinonaktifkan');
          renderIntegrations(main, 'vps');
          refreshBalance();
        } catch (err) {
          toast(err.message);
          b.disabled = false;
        }
      })
    );
    main.querySelectorAll('[data-rotate]').forEach((b) =>
      b.addEventListener('click', () =>
        confirmInline(b, 'Token lama langsung tidak berlaku. Lanjut?', 'Ya, buat token', async () => {
          const r = await api('POST', `/api/vps/${b.dataset.rotate}/rotate`);
          showInstall(main, r);
        })
      )
    );
  }

  function sampleDialog(main, p, list) {
    const n = list.filter((v) => v.demo).length + 1;
    const groups = { x86_64: 'x86_64 (Intel/AMD)', arm64: 'arm64 (Graviton)' };
    const options = Object.entries(groups)
      .map(([arch, label]) => `<optgroup label="${esc(label)}">${p.instances
        .filter((i) => i.arch === arch)
        .map((i) => `<option value="${esc(i.type)}" ${i.type === 't3a.small' ? 'selected' : ''}>${esc(i.type)}: ${esc(i.vcpu)} vCPU, ${esc(i.memGiB)} GiB, ${usd(i.hourly, 4)}/jam</option>`)
        .join('')}</optgroup>`)
      .join('');
    openModal(`<h2>Tambah VPS sample AWS</h2>
      <p class="muted">Pilih tipe EC2 untuk melihat proyeksi biayanya. VPS sample tidak punya riwayat pemakaian, dan proyeksinya baru masuk forecast setelah diaktifkan.</p>
      <form id="sForm" style="display:grid;gap:12px">
        <label>Nama<input id="sName" value="aws-sample-${n}" pattern="[A-Za-z0-9._\\-]+" maxlength="60" required></label>
        <label>Tipe EC2<select id="sType">${options}</select></label>
        <label>Disk EBS gp3 (GB)<input id="sDisk" type="number" min="8" max="16384" value="30" required></label>
        <label class="row" style="gap:8px;color:var(--text)"><input type="checkbox" id="sActive"> Langsung aktifkan proyeksi</label>
        <div class="note" id="sEst" aria-live="polite"></div>
        <p class="err" id="sErr" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit">Tambah</button><button type="button" class="btn" data-close>Batal</button></div>
      </form>`);
    const est = () => {
      const i = p.instances.find((x) => x.type === $('#sType').value);
      const disk = Number($('#sDisk').value) || 0;
      const compute = i.hourly * 730;
      const ipv4 = p.ipv4Hourly * 730;
      const storage = disk * p.ebsGp3;
      $('#sEst').innerHTML = `Proyeksi per bulan (730 jam): <b>${usd(compute + ipv4 + storage)}</b>
        <br><span class="muted">EC2 ${usd(compute)}, EBS ${usd(storage)}, IPv4 ${usd(ipv4)}. Data transfer tidak termasuk.</span>`;
    };
    $('#sType').addEventListener('change', est);
    $('#sDisk').addEventListener('input', est);
    est();
    $('#sForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const v = await api('POST', '/api/samples', { name: $('#sName').value.trim(), instanceType: $('#sType').value, diskGB: Number($('#sDisk').value) });
        if ($('#sActive').checked) await api('PATCH', `/api/vps/${v.id}`, { active: true });
        closeModal();
        toast('VPS sample AWS ditambahkan');
        renderIntegrations(main, 'vps');
        refreshBalance();
      } catch (err) {
        $('#sErr').textContent = err.message;
      }
    });
  }

  // ---------- akun AWS ----------
  async function renderAws(main, tabs) {
    const s = await api('GET', '/api/aws');
    const rep = s.report;
    const reportHtml = rep
      ? `<section class="section"><h2>Tagihan AWS, 30 hari terakhir</h2>
          <dl class="facts" style="max-width:420px;margin-bottom:14px">
            <div><dt>Total 30 hari</dt><dd>${esc(usd(rep.total))} ${esc(rep.currency)}</dd></div>
            <div><dt>Bulan ini</dt><dd>${esc(usd(rep.mtd))} ${esc(rep.currency)}</dd></div>
            <div><dt>Data terbaru</dt><dd>${esc(rep.lastDate)}<small>AWS menunda data sampai 24 jam</small></dd></div>
          </dl>
          <div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Layanan</th><th scope="col" class="num">Biaya</th></tr></thead><tbody>${rep.services
            .map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${esc(usd(x.amount))}</td></tr>`)
            .join('')}</tbody></table></div></section>`
      : s.configured
        ? '<p class="muted">Kredensial tersimpan, tetapi belum ada data. Klik Sinkronkan sekarang.</p>'
        : '';
    const status = s.configured
      ? `<p>Kredensial: <code>${esc(s.keyHint)}</code>${s.fromEnv ? ' (dari environment variable)' : ''}. ${s.lastSync ? `Sinkronisasi terakhir ${esc(fmtTime(s.lastSync))}.` : 'Belum pernah sinkron.'} Permintaan API dipakai: ${esc(s.requests)}.</p>
         ${s.lastError ? `<p class="err" role="alert">${esc(s.lastError)}</p>` : ''}`
      : '<p class="muted">Belum tersambung. Isi kredensial IAM baca-saja di bawah.</p>';
    const body = `${tabs}
      <p class="muted">Menarik tagihan AWS yang sebenarnya lewat Cost Explorer. Angka ini berbeda dari estimasi VPS: ini biaya akun AWS yang sungguh ditagihkan, dan AWS menundanya sampai 24 jam. Data ini tidak mengurangi saldo kredit dan tidak masuk forecast VPS.</p>
      <div class="note"><b>Biaya API:</b> AWS menagih $0.01 per halaman hasil Cost Explorer. Aplikasi ini menyinkronkan otomatis sekali sehari dan membatasi sinkron manual paling cepat tiap ${esc(s.minMinutes)} menit, jadi biayanya sekitar satu sen per hari.</div>
      <section class="box"><h2>Sambungan</h2>${status}
        <form id="awsForm" style="display:grid;gap:10px;max-width:560px;margin-top:10px">
          <label>Access key ID<input id="awsId" autocomplete="off" placeholder="AKIA…" ${s.fromEnv ? 'disabled' : ''}></label>
          <label>Secret access key<input id="awsSecret" type="password" autocomplete="off" placeholder="${s.configured ? 'tersimpan. Isi untuk mengganti.' : 'tempel secret access key'}" ${s.fromEnv ? 'disabled' : ''}></label>
          <p class="err" id="awsErr" role="alert"></p>
          <div class="row"><button class="btn primary" type="submit" ${s.fromEnv ? 'disabled' : ''}>Simpan kredensial</button><button class="btn" type="button" id="awsSync" ${s.configured ? '' : 'disabled'}>Sinkronkan sekarang</button>${s.configured && !s.fromEnv ? '<button class="btn danger" type="button" id="awsClear">Hapus kredensial</button>' : ''}<span id="awsResult" role="status"></span></div>
        </form></section>
      ${reportHtml}
      <section class="section"><h2>Cara membuat kredensial baca-saja</h2>
        <ol class="steps">
          <li>Buka AWS Console, lalu <b>Billing and Cost Management</b>. Di <b>Cost Explorer</b>, klik <b>Launch Cost Explorer</b> kalau belum pernah dibuka. AWS butuh sampai 24 jam untuk menyiapkan data pertama.</li>
          <li>Buka <b>IAM</b>, buat user baru tanpa akses console, lalu pasang kebijakan di bawah.</li>
          <li>Di user itu, buat <b>Access key</b> (use case: Application running outside AWS), lalu tempel ke form di atas.</li>
        </ol>
        <p>Kebijakan IAM minimal, hanya boleh membaca biaya:</p>
        ${codeBox('{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Action": "ce:GetCostAndUsage", "Resource": "*" }\n  ]\n}')}
        <p class="muted" style="margin-top:10px">Secret disimpan di server dan tidak pernah dikirim balik ke browser. Untuk deployment, lebih aman memakai environment variable <code>FINOPS_AWS_ACCESS_KEY_ID</code> dan <code>FINOPS_AWS_SECRET_ACCESS_KEY</code>. Jangan pakai access key akun root.</p>
      </section>
      <section class="section"><h2>Ekspor tanpa terkunci vendor</h2>
        <p>Semua biaya (agent VPS dan AWS) bisa diunduh dengan nama kolom <b>FOCUS</b> (FinOps Open Cost and Usage Specification), standar terbuka yang sama dipakai AWS, Azure, dan Google Cloud. File ini memuat subset kolom FOCUS, dan kolom tambahan diawali <code>x_</code>. VPS sample AWS tidak diekspor karena hanya proyeksi.</p>
        <a class="btn" href="/api/export/focus.csv" download style="display:inline-flex;align-items:center;text-decoration:none">Unduh CSV FOCUS</a>
      </section>`;
    main.innerHTML = pageHtml('Integrations', '', body);

    const result = $('#awsResult');
    $('#awsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#awsErr').textContent = '';
      try {
        await api('PUT', '/api/aws', { accessKeyId: $('#awsId').value, secretAccessKey: $('#awsSecret').value });
        toast('Kredensial tersimpan');
        renderAws(main, tabs);
      } catch (err) {
        $('#awsErr').textContent = err.message;
      }
    });
    $('#awsSync').addEventListener('click', async (e) => {
      e.target.disabled = true;
      result.textContent = 'Menarik data dari AWS…';
      try {
        const r = await api('POST', '/api/aws/sync');
        if (r.error) {
          result.innerHTML = `<span class="s-alert">Gagal: ${esc(r.error)}</span>`;
          e.target.disabled = false;
        } else {
          toast('Sinkronisasi selesai');
          renderAws(main, tabs);
        }
      } catch (err) {
        result.innerHTML = `<span class="s-alert">${esc(err.message)}</span>`;
        e.target.disabled = false;
      }
    });
    const clr = $('#awsClear');
    if (clr)
      clr.addEventListener('click', () =>
        confirmInline(clr, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('PUT', '/api/aws', { clear: true });
          toast('Kredensial dihapus');
          renderAws(main, tabs);
        })
      );
  }

  // ---------- AI model ----------
  async function renderAi(main, tabs) {
    const s = await api('GET', '/api/ai');
    const slotHtml = (name, title, hint) => {
      const c = s[name];
      const opts = Object.entries(s.presets).map(([k, v]) => `<option value="${esc(k)}" ${k === c.provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
      const keyPh = c.keyFromEnv ? 'diatur lewat environment variable' : c.hasKey ? `tersimpan (${c.keyHint}). Isi untuk mengganti.` : 'tempel API key di sini';
      return `<section class="box" data-slot="${name}">
        <div class="page-head"><h2 style="margin:0">${esc(title)}</h2>
          <label class="row" style="gap:10px">Aktif<span class="switch"><input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''}><span></span></span></label></div>
        <p class="muted">${esc(hint)}</p>
        <div class="form-grid">
          <label>Provider<select data-f="provider">${opts}</select></label>
          <label>Model<input data-f="model" value="${esc(c.model)}" placeholder="nama model"></label>
          <label class="span2">Base URL<input data-f="baseUrl" value="${esc(c.baseUrl)}" placeholder="https://.../v1"></label>
          <label class="span2">API key<input data-f="apiKey" type="password" autocomplete="off" placeholder="${esc(keyPh)}" ${c.keyFromEnv ? 'disabled' : ''}></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary" type="button" data-save>Simpan</button><button class="btn" type="button" data-test>Tes koneksi</button>${c.hasKey && !c.keyFromEnv ? '<button class="btn danger" type="button" data-clear>Hapus API key</button>' : ''}<span data-result role="status"></span></div>
      </section>`;
    };
    const body = `${tabs}
      ${slotHtml('primary', 'Model utama', 'Dipakai pertama untuk setiap pertanyaan.')}
      ${slotHtml('backup', 'Model backup', 'Dipakai kalau model utama gagal. Sebaiknya dari provider lain.')}
      <section class="section"><h2>Cara mendapatkan API key</h2>
        <ul>
          <li><b>Google Gemini:</b> <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Ada free tier.</li>
          <li><b>Groq:</b> <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>. Ada free tier.</li>
          <li><b>OpenRouter:</b> <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Isi nama model sendiri, misalnya yang berakhiran <code>:free</code>.</li>
          <li><b>Ollama (lokal):</b> tanpa API key, tetapi hanya jalan kalau server berada di komputer yang sama dengan Ollama.</li>
        </ul>
        <p class="muted">API key disimpan di server dan tidak pernah dikirim balik ke browser. Untuk deployment, sebaiknya pakai environment variable <code>AI_PRIMARY_API_KEY</code> dan <code>AI_BACKUP_API_KEY</code>.</p>
      </section>`;
    main.innerHTML = pageHtml('Integrations', '', body);

    main.querySelectorAll('[data-slot]').forEach((sec) => {
      const name = sec.dataset.slot;
      const f = (k) => sec.querySelector(`[data-f="${k}"]`);
      const result = sec.querySelector('[data-result]');
      f('provider').addEventListener('change', () => {
        const pr = s.presets[f('provider').value];
        f('baseUrl').value = pr.baseUrl;
        f('model').value = pr.model;
      });
      const save = async () => {
        const body = { enabled: f('enabled').checked, provider: f('provider').value, baseUrl: f('baseUrl').value, model: f('model').value };
        if (f('apiKey').value) body.apiKey = f('apiKey').value;
        return api('PUT', `/api/ai/${name}`, body);
      };
      f('enabled').addEventListener('change', () => save().then(() => toast(f('enabled').checked ? 'Model diaktifkan' : 'Model dinonaktifkan')).catch((e) => toast(e.message)));
      sec.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await save();
          toast('Tersimpan');
          renderIntegrations(main, 'ai');
        } catch (e) {
          toast(e.message);
        }
      });
      sec.querySelector('[data-test]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        result.textContent = 'Menguji…';
        try {
          await save();
          const r = await api('POST', `/api/ai/${name}/test`);
          result.innerHTML = r.ok ? `<span class="s-ok">Terhubung: ${esc(r.model)}, ${esc(r.latencyMs)} ms</span>` : `<span class="s-alert">Gagal: ${esc(r.error)}</span>`;
        } catch (err) {
          result.innerHTML = `<span class="s-alert">Gagal: ${esc(err.message)}</span>`;
        }
        e.target.disabled = false;
      });
      const clr = sec.querySelector('[data-clear]');
      if (clr)
        clr.addEventListener('click', () =>
          confirmInline(clr, 'Yakin ingin hapus API key?', 'Ya, hapus', async () => {
            await api('PUT', `/api/ai/${name}`, { clearKey: true });
            toast('API key dihapus');
            renderIntegrations(main, 'ai');
          })
        );
    });
  }

  function connectDialog(main) {
    openModal(`<h2>Connect VPS</h2>
      <form id="cForm" style="display:grid;gap:12px">
        <label>Nama VPS<input id="cName" placeholder="ugm-vps-1" pattern="[A-Za-z0-9._\\-]+" maxlength="60" required></label>
        <p class="muted" style="margin:0">Huruf, angka, titik, strip, dan underscore.</p>
        <p class="err" id="cErr" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit">Buat token</button><button type="button" class="btn" data-close>Batal</button></div>
      </form>`);
    $('#cForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/vps', { name: $('#cName').value.trim() });
        showInstall(main, r);
      } catch (err) {
        $('#cErr').textContent = err.message;
      }
    });
  }

  function showInstall(main, r) {
    const server = r.serverUrl;
    const local = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server);
    const cmd = `curl -fsSL ${server}/agent/install.sh | sudo bash -s -- --server ${server} --token ${r.token}`;
    openModal(`<h2>Install agent di ${esc(r.vps.name)}</h2>
      <div class="note">Salin token sekarang. Token <b>hanya ditampilkan sekali</b>.</div>
      ${local ? `<div class="note">Alamat server di perintah ini adalah <code>${esc(server)}</code>, yang hanya bisa dipakai kalau dashboard berjalan di VPS itu sendiri. Kalau dashboard ada di tempat lain, buka dashboard lewat alamat publiknya, lalu buat token baru.</div>` : ''}
      <ol class="steps">
        <li>SSH ke VPS: <code>ssh user@alamat-vps</code></li>
        <li>Jalankan perintah ini sekali saja:${codeBox(cmd)}Kalau VPS butuh proxy, tambahkan <code>--proxy http://proxy:port</code> di akhir perintah.</li>
        <li>Pastikan output-nya memuat <code>Test report accepted.</code> dan <code>Done.</code></li>
        <li>Tunggu sampai terhubung:<div class="note" id="waitBox" role="status">Menunggu laporan pertama dari agent…</div></li>
      </ol>
      <details><summary>Install manual, tanpa curl ke bash</summary>
        ${codeBox(`curl -fsSL ${server}/agent/install.sh -o install.sh\nless install.sh   # periksa dulu\nsudo bash install.sh --server ${server} --token ${r.token}`)}
      </details>
      <div class="row" style="margin-top:16px"><button class="btn" type="button" data-close>Tutup</button></div>`);
    if (pollTimer) clearInterval(pollTimer);
    const start = Date.now();
    pollTimer = setInterval(async () => {
      try {
        const list = await api('GET', '/api/vps');
        const v = list.find((x) => x.id === r.vps.id);
        if (v && v.lastSeen && v.lastSeen > start - 5000) {
          clearInterval(pollTimer);
          const box = $('#waitBox');
          if (box) box.innerHTML = `<b>Terhubung.</b> Host ${esc(v.last.hostname)} (${esc(v.last.vcpu)} vCPU, ${esc(v.last.memTotalGiB.toFixed(1))} GiB) setara <code>${esc(v.instanceType)}</code> seharga ${usd(v.hourly, 4)} per jam.`;
          renderIntegrations(main, 'vps');
        }
      } catch {
        /* abaikan, coba lagi pada putaran berikutnya */
      }
      if (Date.now() - start > 15 * 60000) clearInterval(pollTimer);
    }, 4000);
  }

  // ---------- titik sambung untuk halaman di file terpisah ----------
  window.App = { $, esc, md, usd, fmtTime, ago, api, toast, copy, codeBox, confirmInline, openModal, closeModal, pageHtml, renderReply, refreshBalance, refreshRecent, router, renderIntegrations, renderArtifactDetail, vpsTable, setPollTimer: (t) => (pollTimer = t), getPollTimer: () => pollTimer };
  const PAGES = (window.Pages = window.Pages || {});
  window.App.pages = PAGES;

  // ---------- mulai ----------
  async function boot() {
    const me = await api('GET', '/api/me');
    if (!me.authed) return showLogin();
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    refreshBalance();
    router();
  }
  boot();
})();
