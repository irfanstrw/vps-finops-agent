'use strict';
(() => {
  // ---------- utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Escape first, then apply **bold** and `code`. Safe because markup is added after escaping.
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
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
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
  const codeBox = (text) => `<div class="copy-wrap"><button class="btn small" data-copy>Salin</button><pre>${esc(text)}</pre></div>`;

  // Inline confirmation next to a button (no browser popup).
  function confirmInline(btn, question, yesLabel, onYes) {
    if (btn.dataset.confirming) return;
    btn.dataset.confirming = '1';
    btn.classList.add('hidden');
    const box = document.createElement('span');
    box.className = 'confirm-inline';
    box.innerHTML = `<span>${esc(question)}</span><button class="btn small danger" data-yes>${esc(yesLabel)}</button><button class="btn small" data-no>Batal</button>`;
    btn.after(box);
    const close = () => {
      box.remove();
      btn.classList.remove('hidden');
      delete btn.dataset.confirming;
    };
    box.querySelector('[data-no]').addEventListener('click', close);
    box.querySelector('[data-yes]').addEventListener('click', async () => {
      box.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await onYes();
      } catch (err) {
        toast(err.message);
        close();
      }
    });
  }

  function openModal(html) {
    $('#modalCard').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalCard').innerHTML = '';
    if (pollTimer) clearInterval(pollTimer);
  }
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });

  // ---------- auth ----------
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

  // theme
  if (localStorage.theme === 'light') document.body.classList.add('light');
  $('#themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('light');
    localStorage.theme = document.body.classList.contains('light') ? 'light' : 'dark';
  });

  // ---------- shell ----------
  let chats = [];
  let pollTimer = null;

  async function refreshRecent() {
    chats = await api('GET', '/api/chats');
    const cur = location.hash.match(/^#\/chat\/(\w+)/)?.[1];
    $('#recent').innerHTML = chats.length
      ? chats.map((c) => `<a href="#/chat/${esc(c.id)}" class="${c.id === cur ? 'active' : ''}" title="${esc(c.title)}">${esc(c.title)}</a>`).join('')
      : '<span class="muted" style="padding:0 8px">Belum ada percakapan</span>';
  }
  async function refreshBalance() {
    try {
      const o = await api('GET', '/api/overview');
      $('#balancePill').innerHTML = `Saldo <b>${esc(usd(o.balance.remaining))}</b>`;
      return o;
    } catch {
      return null;
    }
  }

  $('#newChatBtn').addEventListener('click', () => (location.hash = '#/chat/new'));

  function setActiveNav(name) {
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  }

  async function router() {
    if (pollTimer) clearInterval(pollTimer);
    const h = location.hash || '#/chat/new';
    const [, page, id] = h.match(/^#\/(\w+)(?:\/(\w+))?/) || [];
    setActiveNav(page);
    const main = $('#main');
    try {
      if (page === 'chat') await renderChat(main, id);
      else if (page === 'overview') await renderOverview(main);
      else if (page === 'tasks') await renderTasks(main);
      else if (page === 'automations') await renderAutomations(main);
      else if (page === 'artifacts') await renderArtifacts(main, id);
      else if (page === 'context') await renderContext(main);
      else if (page === 'integrations') await renderIntegrations(main, id);
      else location.hash = '#/chat/new';
    } catch (e) {
      if (e.message !== 'Not signed in') main.innerHTML = `<div class="page"><p class="err">${esc(e.message)}</p></div>`;
    }
    refreshRecent().catch(() => {});
  }
  window.addEventListener('hashchange', router);

  // ---------- reply renderer ----------
  function renderReply(r) {
    const blocks = r.blocks.map((b) => {
      if (b.type === 'p') return `<p>${md(b.text)}</p>`;
      if (b.type === 'h') return `<h4>${md(b.text)}</h4>`;
      if (b.type === 'ul') return `<ul>${b.items.map((i) => `<li>${md(i)}</li>`).join('')}</ul>`;
      if (b.type === 'table')
        return `<div class="tbl-wrap"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
          .map((row) => `<tr>${row.map((c) => `<td>${md(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`;
      return '';
    });
    const steps = r.steps?.length
      ? `<details class="thinking"><summary>Lihat proses analisis (${r.steps.length} langkah)</summary><ol>${r.steps.map((s) => `<li>${md(s)}</li>`).join('')}</ol></details>`
      : '';
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
    main.innerHTML = `
      ${chat ? `<div class="chat-head"><div>${esc(chat.title)} <span class="id" id="showId">Lihat ID</span></div></div>` : ''}
      <div class="messages" id="messages"></div>
      <div class="composer">
        <form id="composer">
          <textarea id="input" maxlength="10000" placeholder="Apa yang ingin kamu tanyakan ke FinOps Agent?"></textarea>
          <button class="send" type="submit" title="Kirim">➤</button>
        </form>
        <div class="meta"><span>Biaya dihitung dengan harga AWS us-east-1 on-demand. Periksa kembali rekomendasi sebelum dijalankan.</span><span id="count">0/10000 karakter maksimum</span></div>
      </div>`;
    const box = $('#messages');
    if (!chat || !chat.messages.length) {
      box.innerHTML = `<div class="empty"><h2>Ada yang bisa dibantu soal <em>biaya</em>?</h2><p>Tanyakan pengeluaran, anomali, forecast, atau rightsizing untuk VPS kamu.</p>
        <div class="suggest" style="justify-content:center">${SUGGESTIONS.map((s) => `<button class="btn small" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    } else {
      box.innerHTML = chat.messages.map((m) => msgHtml(m, chat.id)).join('');
      box.scrollTop = box.scrollHeight;
    }
    if (chat) $('#showId').addEventListener('click', (e) => (e.target.textContent = chat.id));

    const input = $('#input');
    input.addEventListener('input', () => ($('#count').textContent = `${input.value.length}/10000 karakter maksimum`));
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
        }
        if (!chat.messages.length) box.innerHTML = '';
        box.insertAdjacentHTML('beforeend', msgHtml({ role: 'user', text, ts: Date.now() }));
        box.insertAdjacentHTML('beforeend', `<div class="msg agent" id="pending"><div class="who">FinOps Agent</div><div class="body muted">Menganalisis…</div></div>`);
        box.scrollTop = box.scrollHeight;
        const r = await api('POST', `/api/chats/${chat.id}/messages`, { text });
        chat.messages.push(r.user, r.agent);
        $('#pending').outerHTML = msgHtml(r.agent, chat.id);
        box.scrollTop = box.scrollHeight;
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
    return `<div class="msg agent"><div class="who">FinOps Agent ${engine}</div><div class="body">${renderReply(m.reply)}
      ${m.id && chatId ? `<div class="msg-actions"><button class="btn small" data-save="${esc(m.id)}" data-chat="${esc(chatId)}">Simpan sebagai artifact</button></div>` : ''}</div></div>`;
  }

  // ---------- overview ----------
  function chartHtml(daily) {
    const max = Math.max(...daily.map((d) => d.total), 0.000001);
    const keys = ['compute', 'storage', 'ipv4', 'egress'];
    const bars = daily
      .map((d) => {
        const segs = keys.map((k) => `<div class="seg c-${k}" style="height:${(d[k] / max) * 100}%"></div>`).join('');
        return `<div class="bar" title="${esc(d.date)}: ${esc(usd(d.total))}">${segs}</div>`;
      })
      .join('');
    return `<div class="chart">${bars}</div>
      <div class="chart-x"><span>${esc(daily[0]?.date)}</span><span>maks ${esc(usd(max))}/hari</span><span>${esc(daily[daily.length - 1]?.date)}</span></div>
      <div class="legend"><span><i class="c-compute"></i>EC2 compute</span><span><i class="c-storage"></i>EBS gp3</span><span><i class="c-ipv4"></i>Public IPv4</span><span><i class="c-egress"></i>Data transfer out</span></div>`;
  }

  async function renderOverview(main) {
    const o = await refreshBalance();
    if (!o) return;
    const budget = o.budget?.amount || 0;
    main.innerHTML = `<div class="page">
      <div class="page-head"><h2>Ringkasan</h2><span class="muted">Region ${esc(o.region.name)} (${esc(o.region.code)})</span></div>
      <div class="cards">
        <div class="card"><div class="label">Saldo kredit</div><div class="value">${usd(o.balance.remaining)}</div><div class="sub">dari total kredit ${usd(o.balance.credit)}</div></div>
        <div class="card"><div class="label">Bulan berjalan (${esc(o.mtd.month)})</div><div class="value">${usd(o.mtd.total)}</div></div>
        <div class="card"><div class="label">Forecast bulan ini</div><div class="value">${usd(o.forecast.forecast)}</div><div class="sub">${budget ? `budget ${usd(budget)}` : 'budget belum diatur'}</div></div>
        <div class="card"><div class="label">Run rate</div><div class="value">${usd(o.forecast.runRatePerHour * 24)}/hari</div><div class="sub">${usd(o.forecast.runRatePerHour, 4)}/jam</div></div>
      </div>
      <div class="section"><h3>Biaya harian, 30 hari terakhir</h3>${chartHtml(o.daily)}</div>
      <div class="section"><div class="page-head" style="margin:0 0 8px"><h3>VPS</h3><a class="btn small" href="#/integrations">Kelola</a></div>
        ${o.vps.length ? vpsTable(o.vps) : '<p class="muted">Belum ada VPS yang terhubung. <a href="#/integrations">Hubungkan sekarang</a>.</p>'}</div>
      <div class="section"><h3>Anomali, 30 hari terakhir</h3>
        ${o.anomalies.length
          ? `<div class="tbl-wrap"><table><thead><tr><th>Tanggal</th><th>VPS</th><th>Service</th><th>Perkiraan</th><th>Aktual</th><th>Dampak</th></tr></thead><tbody>${o.anomalies
              .map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.vpsName)}</td><td>${esc(a.service)}</td><td>${usd(a.expected)}</td><td>${usd(a.actual)}</td><td>${usd(a.impact)}</td></tr>`)
              .join('')}</tbody></table></div>`
          : '<p class="muted">Tidak ada.</p>'}
      </div>
      <div class="section"><h3>Top up kredit</h3>
        <form id="topup" class="row"><input type="number" min="1" max="100000" step="1" value="100" style="width:140px" id="topupAmt"><button class="btn">Tambah kredit</button></form>
      </div>
    </div>`;
    $('#topup').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/settings/topup', { amount: Number($('#topupAmt').value) });
        toast('Kredit ditambahkan');
        renderOverview(main);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function vpsTable(list, actions = false) {
    return `<div class="tbl-wrap"><table><thead><tr><th>Nama</th><th>Status</th><th>Host / OS</th><th>Spesifikasi</th><th>Setara EC2</th><th>$/jam</th><th>Bulan ini</th><th>Terakhir aktif</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
      ${list
        .map((v) => {
          const l = v.last;
          return `<tr>
            <td>${esc(v.name)}</td>
            <td><span class="status s-${esc(v.status)}">${esc(v.demo ? (v.active ? 'proyeksi aktif' : 'sample') : v.status)}</span></td>
            <td>${v.demo ? '<span class="muted">sample AWS</span>' : l ? `${esc(l.hostname)}<br><span class="muted">${esc(l.os)}</span>` : '-'}</td>
            <td>${l ? `${esc(l.vcpu)} vCPU · ${esc(l.memTotalGiB.toFixed(1))} GiB · ${esc(l.diskTotalGB.toFixed(0))} GB` : '-'}</td>
            <td>${v.instanceType ? `<code>${esc(v.instanceType)}</code>` : '-'}</td>
            <td>${v.hourly ? usd(v.hourly, 4) : '-'}</td>
            <td>${v.demo ? `<span class="muted">proyeksi</span> ${usd(v.projectedMonthly)}/bln` : usd(v.mtd)}</td>
            <td>${v.demo ? '-' : esc(ago(v.lastSeen))}</td>
            ${actions ? `<td class="row">${
              v.demo
                ? `<button class="btn small ${v.active ? '' : 'primary'}" data-active="${esc(v.id)}" data-on="${v.active ? '0' : '1'}">${v.active ? 'Nonaktifkan proyeksi' : 'Aktifkan proyeksi'}</button>`
                : `<button class="btn small" data-rotate="${esc(v.id)}">Token baru</button>`
            }<button class="btn small danger" data-del="${esc(v.id)}">Hapus</button></td>` : ''}
          </tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  // ---------- tasks ----------
  async function renderTasks(main) {
    const tasks = await api('GET', '/api/tasks');
    main.innerHTML = `<div class="page"><div class="page-head"><h2>Tasks</h2><span class="muted">Semua permintaan chat dan eksekusi automation</span></div>
      ${tasks.length
        ? `<div class="tbl-wrap"><table><thead><tr><th>Waktu</th><th>Task</th><th>Trigger</th><th>Status</th><th>Ringkasan</th><th></th></tr></thead><tbody>${tasks
            .map(
              (t) => `<tr><td>${esc(fmtTime(t.ts))}</td><td>${esc(t.name)}</td><td>${esc(t.trigger)}</td><td><span class="status s-${esc(t.status)}">${esc(t.status)}</span></td><td>${esc(t.summary)}</td>
              <td>${t.chatId ? `<a href="#/chat/${esc(t.chatId)}">Buka chat</a>` : t.artifactId ? `<a href="#/artifacts/${esc(t.artifactId)}">Buka laporan</a>` : ''}</td></tr>`
            )
            .join('')}</tbody></table></div>`
        : '<p class="muted">Belum ada task.</p>'}</div>`;
  }

  // ---------- automations ----------
  async function renderAutomations(main) {
    const list = await api('GET', '/api/automations');
    main.innerHTML = `<div class="page"><div class="page-head"><h2>Automations</h2><span class="muted">Dicek setiap menit. Hasilnya masuk ke Tasks dan Artifacts.</span></div>
      ${list
        .map(
          (a) => `<div class="section" data-id="${esc(a.id)}">
          <div class="page-head" style="margin-bottom:6px"><h3>${esc(a.name)}</h3>
            <label class="switch" title="Aktif"><input type="checkbox" data-toggle ${a.enabled ? 'checked' : ''}><span></span></label></div>
          <p class="muted" style="margin:0 0 10px">${esc(a.description)}</p>
          <div class="row">
            <label>Setiap <input type="number" min="1" max="720" value="${esc(a.intervalHours)}" data-interval style="width:80px"> jam</label>
            ${a.type === 'budget' ? `<label>Budget $<input type="number" min="0" step="1" value="${esc(a.params.monthlyBudgetUsd)}" data-budget style="width:100px">/bulan</label>` : ''}
            <button class="btn small" data-savea>Simpan</button>
            <button class="btn small primary" data-run>Jalankan sekarang</button>
          </div>
          <p class="muted" style="margin:10px 0 0">Terakhir dijalankan: ${esc(fmtTime(a.lastRun))}${a.lastResult ? ` · <span class="${a.lastResult.alert ? 's-alert' : 's-ok'}">${esc(a.lastResult.summary)}</span>` : ''}</p>
        </div>`
        )
        .join('')}</div>`;
    main.querySelectorAll('.section[data-id]').forEach((sec) => {
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
    if (id) {
      const a = await api('GET', `/api/artifacts/${encodeURIComponent(id)}`);
      main.innerHTML = `<div class="page"><div class="page-head"><h2>${esc(a.title)}</h2>
        <div class="row"><a class="btn small" href="#/artifacts">Kembali</a><button class="btn small" id="dl">Unduh JSON</button><button class="btn small danger" id="delA">Hapus</button></div></div>
        <div class="section">${renderReply(a.reply)}</div></div>`;
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
      return;
    }
    const list = await api('GET', '/api/artifacts');
    main.innerHTML = `<div class="page"><div class="page-head"><h2>Artifacts</h2><span class="muted">Laporan tersimpan dari chat dan automation</span></div>
      ${list.length
        ? `<div class="tbl-wrap"><table><thead><tr><th>Judul</th><th>Sumber</th><th>Dibuat</th></tr></thead><tbody>${list
            .map((a) => `<tr><td><a href="#/artifacts/${esc(a.id)}">${esc(a.title)}</a></td><td>${esc(a.source.split(':')[0])}</td><td>${esc(fmtTime(a.ts))}</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<p class="muted">Belum ada artifact. Klik "Simpan sebagai artifact" di bawah jawaban agent, atau jalankan automation.</p>'}</div>`;
  }

  // ---------- context files ----------
  async function renderContext(main) {
    const list = await api('GET', '/api/context-files');
    main.innerHTML = `<div class="page"><div class="page-head"><h2>Context files</h2></div>
      <div class="section"><p class="muted" style="margin-top:0">Catatan yang bisa dipakai agent. Baris seperti <code>budget: 30</code> mengatur budget bulanan untuk forecast dan menggantikan nilai di automation budget.</p>
        <form id="ctxForm" style="display:grid;gap:8px">
          <input id="ctxName" placeholder="Nama, misalnya budget.txt" maxlength="200" required>
          <textarea id="ctxContent" rows="5" placeholder="budget: 30&#10;owner: lab-ugm" required></textarea>
          <div class="row"><button class="btn primary">Tambah</button><label class="btn small">Unggah file<input type="file" id="ctxFile" accept=".txt,.md,.json,.csv,.yaml,.yml" hidden></label></div>
        </form></div>
      ${list
        .map(
          (f) => `<div class="section"><div class="page-head" style="margin-bottom:6px"><h3>${esc(f.name)}</h3><button class="btn small danger" data-delctx="${esc(f.id)}">Hapus</button></div>
          <pre>${esc(f.content)}</pre></div>`
        )
        .join('')}</div>`;
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
    tab = tab === 'ai' ? 'ai' : 'vps';
    const tabs = `<div class="tabs"><a href="#/integrations/vps" class="${tab === 'vps' ? 'active' : ''}">VPS</a><a href="#/integrations/ai" class="${tab === 'ai' ? 'active' : ''}">AI Model</a></div>`;
    if (tab === 'ai') return renderAi(main, tabs);

    const [list, p] = await Promise.all([api('GET', '/api/vps'), api('GET', '/api/pricing')]);
    const origin = location.origin;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    main.innerHTML = `<div class="page">
      <div class="page-head"><h2>Integrations</h2>
        <div class="row"><button class="btn" id="sampleBtn">＋ Tambah VPS sample AWS</button><button class="btn primary" id="connectBtn">＋ Connect VPS</button></div></div>
      ${tabs}

      <div class="callout">Agent membaca pemakaian CPU, RAM, disk, dan network dari VPS kamu. Pemakaian itu dihitung dengan harga instance EC2 termurah yang setara di <b>${esc(p.region.name)}</b>, lalu dipotong dari saldo kredit.
        <br><b>VPS sample AWS</b> tidak punya riwayat. Biayanya hanya berupa <b>proyeksi</b> dan baru dihitung ke forecast setelah kamu klik <b>Aktifkan proyeksi</b>.</div>

      <div class="section"><h3>VPS terhubung</h3>
        ${list.length ? vpsTable(list, true) : '<p class="muted">Belum ada yang terhubung. Klik <b>Connect VPS</b> atau <b>Tambah VPS sample AWS</b>.</p>'}</div>

      <div class="section"><h3>Cara menghubungkan VPS, langkah demi langkah</h3>
        <div class="steps">
          <div class="step"><div><b>Siapkan VPS.</b> Kebutuhan: Linux dengan systemd (Ubuntu/Debian/CentOS/Rocky), <code>bash</code>, <code>curl</code>, dan user dengan akses <code>sudo</code>.
            <p class="muted" style="margin:4px 0">Cek di VPS:</p>${codeBox('systemctl --version | head -1; curl --version | head -1; sudo -v && echo sudo-ok')}</div></div>
          <div class="step"><div><b>Pastikan VPS bisa mengakses dashboard ini.</b> Agent mengirim data <i>keluar</i> dari VPS ke alamat dashboard, jadi VPS tidak perlu membuka port apa pun.
            ${isLocal ? `<div class="callout">Dashboard sedang dibuka lewat <code>${esc(origin)}</code>. Alamat ini hanya bisa dijangkau dari komputer ini. Buka dashboard lewat alamat publiknya (misalnya <code>https://xxxx.trycloudflare.com</code>), atau atur <code>PUBLIC_URL</code> saat menjalankan server.</div>` : ''}
            <p class="muted" style="margin:4px 0">Tes dari VPS. Hasilnya harus <code>{"authed":false}</code>:</p>${codeBox(`curl -sS ${origin}/api/me`)}
            <p class="muted" style="margin:4px 0">Kalau perintahnya timeout, cek firewall, VPN, atau proxy kampus. Kalau butuh proxy, tambahkan <code>--proxy http://proxy:port</code> di langkah 4.</p></div></div>
          <div class="step"><div><b>Klik "Connect VPS"</b> lalu beri nama (misalnya <code>ugm-vps-1</code>). Kamu akan mendapat token dan perintah install. Token hanya ditampilkan sekali.</div></div>
          <div class="step"><div><b>SSH ke VPS lalu jalankan perintah install</b> yang muncul. Script install akan:
            <ul class="muted" style="margin:4px 0"><li>memasang agent di <code>/usr/local/bin/finops-agent</code></li><li>menyimpan token di <code>/etc/finops-agent.env</code> (mode 600, hanya root)</li><li>membuat systemd service <code>finops-agent</code> yang berjalan tanpa hak root (DynamicUser) dan read-only</li><li>mengirim satu laporan tes, lalu menyalakan service</li></ul>
            Kamu bisa membaca script-nya dulu: <a href="/agent/install.sh" target="_blank" rel="noopener">install.sh</a> · <a href="/agent/finops-agent.sh" target="_blank" rel="noopener">finops-agent.sh</a></div></div>
          <div class="step"><div><b>Tunggu sampai status jadi "online"</b>. Jendela install akan berubah sendiri begitu laporan pertama masuk. Biaya mulai dihitung sejak laporan kedua (satu laporan setiap 60 detik).</div></div>
          <div class="step"><div><b>Tanya agent</b>, misalnya "Status VPS" atau "Forecast bulan ini".</div></div>
        </div>
      </div>

      <div class="section"><h3>Troubleshooting</h3>
        <p class="muted" style="margin:0 0 6px">Status service dan log di VPS:</p>${codeBox('systemctl status finops-agent --no-pager\njournalctl -u finops-agent -n 50 --no-pager')}
        <p class="muted" style="margin:10px 0 6px">Kirim satu laporan secara manual:</p>${codeBox("sudo bash -c 'set -a; . /etc/finops-agent.env; set +a; /usr/local/bin/finops-agent --once'")}
        <ul class="muted">
          <li><b>401 / token ditolak:</b> klik <b>Token baru</b> di samping VPS, lalu jalankan ulang perintah install yang muncul.</li>
          <li><b>Cannot reach:</b> alamat dashboard tidak bisa dijangkau VPS. Cek firewall, VPN, atau tambahkan <code>--proxy</code>.</li>
          <li><b>Status "offline":</b> tidak ada laporan selama 3 menit atau lebih. Jeda lebih dari 5 menit tidak ditagih.</li>
          <li><b>URL tunnel berganti:</b> jalankan ulang perintah install dengan URL baru, atau pakai domain tetap.</li>
        </ul>
        <p class="muted" style="margin:10px 0 6px">Uninstall agent:</p>${codeBox(`curl -fsSL ${origin}/agent/uninstall.sh | sudo bash`)}
      </div>

      <div class="section"><h3>Harga yang dipakai (AWS ${esc(p.region.code)}, on-demand Linux)</h3>
        <ul class="muted" style="margin-top:0">
          <li>EC2: instance termurah dengan vCPU dan RAM minimal sama dengan VPS, arsitektur CPU sama (x86_64 atau arm64)</li>
          <li>EBS gp3: ${usd(p.ebsGp3)}/GB-bulan dari total ukuran disk</li>
          <li>Public IPv4: ${usd(p.ipv4Hourly, 3)}/jam</li>
          <li>Data transfer out: ${esc(p.egressFreeGB)} GB/bulan pertama gratis, selanjutnya ${usd(p.egressPerGB)}/GB</li>
        </ul>
        <details><summary class="link">Daftar harga instance</summary><div class="tbl-wrap"><table><thead><tr><th>Instance</th><th>Arch</th><th>vCPU</th><th>RAM GiB</th><th>$/jam</th><th>$/bulan</th></tr></thead><tbody>
          ${p.instances.map((i) => `<tr><td><code>${esc(i.type)}</code></td><td>${esc(i.arch)}</td><td>${esc(i.vcpu)}</td><td>${esc(i.memGiB)}</td><td>${usd(i.hourly, 4)}</td><td>${usd(i.hourly * 730)}</td></tr>`).join('')}
        </tbody></table></div></details>
      </div>
    </div>`;

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
        .map((i) => `<option value="${esc(i.type)}" ${i.type === 't3a.small' ? 'selected' : ''}>${esc(i.type)} · ${esc(i.vcpu)} vCPU · ${esc(i.memGiB)} GiB · ${usd(i.hourly, 4)}/jam</option>`)
        .join('')}</optgroup>`)
      .join('');
    openModal(`<h2>Tambah VPS sample AWS</h2>
      <p class="muted" style="margin-top:0">Pilih tipe EC2 untuk melihat proyeksi biayanya. VPS sample tidak punya riwayat pemakaian, dan proyeksinya baru masuk ke forecast setelah diaktifkan.</p>
      <form id="sForm" style="display:grid;gap:12px">
        <label>Nama<input id="sName" value="aws-sample-${n}" pattern="[A-Za-z0-9._\\-]+" maxlength="60" required></label>
        <label>Tipe EC2<select id="sType">${options}</select></label>
        <label>Disk EBS gp3 (GB)<input id="sDisk" type="number" min="8" max="16384" value="30" required></label>
        <label class="row" style="gap:8px"><input type="checkbox" id="sActive" style="width:auto"> Langsung aktifkan proyeksi</label>
        <div class="callout" id="sEst"></div>
        <p class="err" id="sErr"></p>
        <div class="row"><button class="btn primary">Tambah</button><button type="button" class="btn" data-close>Batal</button></div>
      </form>`);
    const est = () => {
      const i = p.instances.find((x) => x.type === $('#sType').value);
      const disk = Number($('#sDisk').value) || 0;
      const compute = i.hourly * 730;
      const ipv4 = p.ipv4Hourly * 730;
      const storage = disk * p.ebsGp3;
      $('#sEst').innerHTML = `Proyeksi per bulan (730 jam): <b>${usd(compute + ipv4 + storage)}</b>
        <br><span class="muted">EC2 ${usd(compute)} · EBS ${usd(storage)} · IPv4 ${usd(ipv4)} · data transfer tidak termasuk</span>`;
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

  // ---------- AI model ----------
  async function renderAi(main, tabs) {
    const s = await api('GET', '/api/ai');
    const slotHtml = (name, title, hint) => {
      const c = s[name];
      const opts = Object.entries(s.presets).map(([k, v]) => `<option value="${esc(k)}" ${k === c.provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
      return `<div class="section" data-slot="${name}">
        <div class="page-head" style="margin-bottom:6px"><h3>${esc(title)}</h3>
          <label class="row" style="gap:8px">Aktif <span class="switch"><input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''}><span></span></span></label></div>
        <p class="muted" style="margin:0 0 12px">${esc(hint)}</p>
        <div class="form-grid">
          <label>Provider<select data-f="provider">${opts}</select></label>
          <label>Model<input data-f="model" value="${esc(c.model)}" placeholder="nama model"></label>
          <label class="span2">Base URL<input data-f="baseUrl" value="${esc(c.baseUrl)}" placeholder="https://.../v1"></label>
          <label class="span2">API Key<input data-f="apiKey" type="password" autocomplete="off" placeholder="${c.keyFromEnv ? 'diatur lewat environment variable' : c.hasKey ? `tersimpan (${esc(c.keyHint)}). Isi untuk mengganti.` : 'tempel API key di sini'}" ${c.keyFromEnv ? 'disabled' : ''}></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary small" data-save>Simpan</button><button class="btn small" data-test>Tes koneksi</button>${c.hasKey && !c.keyFromEnv ? '<button class="btn small danger" data-clear>Hapus API key</button>' : ''}<span class="muted" data-result></span></div>
      </div>`;
    };
    main.innerHTML = `<div class="page">
      <div class="page-head"><h2>Integrations</h2></div>
      ${tabs}
      <div class="callout">AI model bersifat <b>opsional</b>. Model hanya memilih tool analisis dan merangkum hasilnya. Semua angka tetap dihitung oleh kode. Urutan pemakaian: <b>Model utama → Model backup → Rule-based agent</b>, jadi chat tetap jalan walaupun model error, timeout, atau kena rate limit.</div>
      ${slotHtml('primary', 'Model utama', 'Dipakai pertama untuk setiap pertanyaan.')}
      ${slotHtml('backup', 'Model backup', 'Dipakai kalau model utama gagal. Sebaiknya dari provider lain.')}
      <div class="section"><h3>Cara mendapatkan API key</h3>
        <ul class="muted" style="margin-top:0">
          <li><b>Google Gemini:</b> <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Tersedia free tier.</li>
          <li><b>Groq:</b> <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>. Tersedia free tier.</li>
          <li><b>OpenRouter:</b> <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Isi nama model sendiri, misalnya model berakhiran <code>:free</code>.</li>
          <li><b>Ollama (lokal):</b> tidak perlu API key, cukup jalankan <code>ollama serve</code> di mesin yang sama dengan server.</li>
        </ul>
        <p class="muted">API key disimpan di server (<code>data/db.json</code>) dan tidak pernah dikirim balik ke browser. Untuk deployment, sebaiknya pakai environment variable <code>AI_PRIMARY_API_KEY</code> dan <code>AI_BACKUP_API_KEY</code>.</p>
      </div>
    </div>`;

    main.querySelectorAll('[data-slot]').forEach((sec) => {
      const name = sec.dataset.slot;
      const f = (k) => sec.querySelector(`[data-f="${k}"]`);
      const result = sec.querySelector('[data-result]');
      f('provider').addEventListener('change', () => {
        const p = s.presets[f('provider').value];
        f('baseUrl').value = p.baseUrl;
        f('model').value = p.model;
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
          result.innerHTML = r.ok ? `<span class="s-ok">✓ Terhubung (${esc(r.model)}, ${esc(r.latencyMs)} ms)</span>` : `<span class="s-alert">✗ ${esc(r.error)}</span>`;
        } catch (err) {
          result.innerHTML = `<span class="s-alert">✗ ${esc(err.message)}</span>`;
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
      <form id="cForm" style="display:grid;gap:10px">
        <label>Nama<input id="cName" placeholder="ugm-vps-1" pattern="[A-Za-z0-9._\\-]+" maxlength="60" required></label>
        <p class="err" id="cErr"></p>
        <div class="row"><button class="btn primary">Buat token</button><button type="button" class="btn" data-close>Batal</button></div>
      </form>`);
    $('#cName').focus();
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
    openModal(`<h2>Install agent di "${esc(r.vps.name)}"</h2>
      <div class="callout">Salin token sekarang. Token <b>hanya ditampilkan sekali</b>.</div>
      ${local ? `<div class="callout">Alamat server di perintah ini <code>${esc(server)}</code>, yang hanya bisa dipakai kalau dashboard berjalan <b>di VPS itu sendiri</b>. Kalau dashboard ada di tempat lain, buka dashboard lewat alamat publiknya dulu, lalu buat token baru.</div>` : ''}
      <p><b>1.</b> SSH ke VPS: <code>ssh user@alamat-vps</code></p>
      <p><b>2.</b> Jalankan perintah ini (sekali saja):</p>${codeBox(cmd)}
      <p class="muted">Kalau VPS butuh proxy, tambahkan <code>--proxy http://proxy:port</code> di akhir perintah.</p>
      <p><b>3.</b> Pastikan output-nya ada <code>Test report accepted.</code> dan <code>Done.</code></p>
      <p><b>4.</b> Tunggu sampai terhubung:</p>
      <div class="callout" id="waitBox">⏳ Menunggu laporan pertama dari agent…</div>
      <details><summary class="link">Install manual (kalau tidak mau pakai curl | bash)</summary>
        ${codeBox(`curl -fsSL ${server}/agent/install.sh -o install.sh\nless install.sh   # periksa dulu\nsudo bash install.sh --server ${server} --token ${r.token}`)}
      </details>
      <div class="row" style="margin-top:14px"><button class="btn" data-close>Tutup</button></div>`);
    if (pollTimer) clearInterval(pollTimer);
    const start = Date.now();
    pollTimer = setInterval(async () => {
      try {
        const list = await api('GET', '/api/vps');
        const v = list.find((x) => x.id === r.vps.id);
        if (v && v.lastSeen && v.lastSeen > start - 5000) {
          clearInterval(pollTimer);
          const box = $('#waitBox');
          if (box) {
            box.className = 'callout ok';
            box.innerHTML = `✅ Terhubung. Host <b>${esc(v.last.hostname)}</b> (${esc(v.last.vcpu)} vCPU, ${esc(v.last.memTotalGiB.toFixed(1))} GiB) setara <code>${esc(v.instanceType)}</code> seharga ${usd(v.hourly, 4)}/jam.`;
          }
          renderIntegrations(main, 'vps');
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - start > 15 * 60000) clearInterval(pollTimer);
    }, 4000);
  }

  // ---------- boot ----------
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
