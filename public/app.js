'use strict';
(() => {
  // ---------- utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Escape dulu, baru terapkan **tebal** dan `kode`. Aman karena markup ditambahkan setelah escape.
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const usd = (n, d = 2) => {
    if (n == null || !Number.isFinite(n)) return '-';
    if (Math.abs(n) < 0.00005) n = 0; // sisa pembulatan, misalnya -0.0000001
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
      $('#balancePill').innerHTML = `Budget tersisa <b>${esc(usd(o.budget.remaining))}</b>`;
      return o;
    } catch {
      return null;
    }
  }
  $('#newChatBtn').addEventListener('click', () => {
    if (location.hash === '#/chat/new') router();
    else location.hash = '#/chat/new';
  });

  const TITLES = { chat: 'Chat', overview: 'Dashboard', plan: 'Planning', automations: 'Automations', artifacts: 'Artifacts', context: 'Context files', integrations: 'Integrations' };
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
        else if (b.kind === 'line') g = C.line({ rows: b.rows.map((r) => ({ ...r, label: String(r.date).slice(5) })), label: b.title, height: 180, refLine: b.ref?.value, refLabel: b.ref?.label ? `Budget ${b.ref.label.replace(/^budget /, '')}` : '', valueLabel: 'Total sejak awal bulan' });
        else if (b.kind === 'donut') g = C.donut({ slices: b.slices, label: b.title, size: 130 });
        else if (b.kind === 'hbars') g = C.hbars({ rows: b.rows, label: b.title, ref: b.ref, refLabel: b.ref ? `budget ${usd(b.ref)}` : '' });
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
    'Ringkasan biaya',
    'Forecast bulan ini',
    'Cari peluang hemat',
    'Daftar server',
    'Cek lonjakan biaya 7 hari',
    'Rekomendasi server untuk toko online budget $30',
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
          <textarea id="input" maxlength="10000" placeholder="Tanya soal biaya server kamu"></textarea>
          <button class="btn primary" type="submit">Kirim</button>
        </form>
        <div class="meta"><span>Angka dihitung dari data server dan daftar harga resmi. Cek lagi sebelum mengubah server.</span><span id="count">0/10000 karakter</span></div>
      </div>`;
    const box = $('#messages');
    if (!chat || !chat.messages.length) {
      box.innerHTML = `<div class="empty"><h1>Tanya biaya server kamu</h1><p class="muted">Jawaban diambil dari server terdaftar di AWS, Azure, dan Google Cloud: biaya, forecast, peluang hemat, dan rekomendasi spesifikasi.</p>
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
            ${a.type === 'budget' ? '<a href="#/overview" style="align-self:center">Atur budget di Dashboard</a>' : ''}
            <button class="btn" type="button" data-savea>Simpan</button>
            <button class="btn primary" type="button" data-run>Jalankan sekarang</button>
          </div>
          <p class="muted" style="margin:10px 0 0">Terakhir dijalankan: ${esc(fmtTime(a.lastRun))}${a.lastResult ? `. Hasil: <span class="${a.lastResult.alert ? 's-alert' : 's-ok'}">${esc(a.lastResult.summary)}</span>` : ''}</p>
        </section>`
      )
      .join('');
    main.innerHTML = pageHtml('Automations', '<span class="muted">Dijalankan otomatis saat jatuh tempo. Hasilnya tersimpan di Artifacts.</span>', body);
    main.querySelectorAll('section[data-id]').forEach((sec) => {
      const id = sec.dataset.id;
      $('[data-toggle]', sec).addEventListener('change', async (e) => {
        await api('PATCH', `/api/automations/${id}`, { enabled: e.target.checked }).catch((err) => toast(err.message));
      });
      $('[data-savea]', sec).addEventListener('click', async () => {
        const body = { intervalHours: Number($('[data-interval]', sec).value) };
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
      <div class="box"><p class="muted">Catatan tim yang disimpan bersama data biaya, misalnya kebijakan tag, pemilik server, atau batas pengeluaran per proyek.</p>
        <form id="ctxForm" style="display:grid;gap:10px;max-width:640px">
          <label>Nama file<input id="ctxName" placeholder="kebijakan-server.md" maxlength="200" required></label>
          <label>Isi<textarea id="ctxContent" rows="5" placeholder="Server produksi wajib punya tag owner." required></textarea></label>
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
    tab = ['ai', 'aws', 'azure', 'gcp'].includes(tab) ? tab : 'aws';
    const cur = (t) => (tab === t ? 'aria-current="page"' : '');
    const logo = (id) => (window.Logos ? window.Logos.badge(id, 'logo xs') : '');
    const tabs = `<nav class="tabs" aria-label="Integrations"><a href="#/integrations/aws" ${cur('aws')}>${logo('aws')}AWS</a><a href="#/integrations/azure" ${cur('azure')}>${logo('azure')}Azure</a><a href="#/integrations/gcp" ${cur('gcp')}>${logo('gcp')}Google Cloud</a><a href="#/integrations/ai" ${cur('ai')}>AI Model</a></nav>`;
    if (tab === 'ai') return renderAi(main, tabs);
    return window.App.renderCloudTab(main, tabs, tab);

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

  // ---------- titik sambung untuk halaman di file terpisah ----------
  window.App = { $, esc, md, usd, fmtTime, ago, api, toast, copy, codeBox, confirmInline, openModal, closeModal, pageHtml, renderReply, refreshBalance, refreshRecent, router, renderIntegrations, renderArtifactDetail, setPollTimer: (t) => (pollTimer = t), getPollTimer: () => pollTimer };
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
