'use strict';
// Tab Integrations untuk AWS, Azure, dan Google Cloud. Ketiganya memakai pola yang sama:
// kredensial read-only, sinkron manual (dibatasi), daftar server, tagihan, dan langkah penyiapan.
// File ini juga berisi halaman Artifacts (hapus satu per satu atau sekaligus).
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml, confirmInline, codeBox, fmtTime } = A;
  const C = window.Charts;
  const L = window.Logos;

  const DEFS = {
    aws: {
      title: 'AWS',
      intro: 'Membaca daftar server EC2 dan tagihan AWS dengan kredensial IAM read-only.',
      cost: 'Daftar server EC2 gratis. Cost Explorer menagih $0.01 per halaman hasil, jadi sinkron otomatis hanya sekali sehari dan sinkron manual paling cepat tiap 10 menit.',
      fields: [
        { k: 'accessKeyId', label: 'Access key ID', ph: 'AKIA...', type: 'text', secret: false },
        { k: 'secretAccessKey', label: 'Secret access key', ph: 'tempel secret access key', type: 'password', secret: true },
        { k: 'regions', label: 'Region server EC2 (pisahkan dengan koma)', ph: 'us-east-1, ap-southeast-1', type: 'text', keep: true },
      ],
      steps: [
        'Buka <b>IAM</b> di AWS Console, buat user baru tanpa akses console, lalu pasang kebijakan di bawah.',
        'Di user itu, buat <b>Access key</b> (use case: Application running outside AWS), lalu tempel ke form.',
        'Isi region tempat server EC2 kamu berada, misalnya <code>ap-southeast-1</code> untuk Singapura.',
        'Opsional untuk tagihan asli: buka <b>Billing and Cost Management</b>, lalu <b>Cost Explorer</b> dan klik <b>Launch Cost Explorer</b>. Data pertama butuh sampai 24 jam.',
      ],
      policy: '{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Action": ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ce:GetCostAndUsage"], "Resource": "*" }\n  ]\n}',
      env: 'FINOPS_AWS_ACCESS_KEY_ID, FINOPS_AWS_SECRET_ACCESS_KEY, dan FINOPS_AWS_REGIONS',
    },
    azure: {
      title: 'Azure',
      intro: 'Membaca daftar Azure VM dan tagihan Azure dengan service principal read-only.',
      cost: 'Daftar VM dan query Cost Management tidak ditagih, tetapi Azure membatasi jumlah permintaan. Sinkron otomatis sekali sehari, manual paling cepat tiap 10 menit.',
      fields: [
        { k: 'tenantId', label: 'Tenant ID', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'clientId', label: 'Client ID (Application ID)', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'subscriptionId', label: 'Subscription ID', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'clientSecret', label: 'Client secret', ph: 'tempel nilai secret', type: 'password', secret: true },
      ],
      steps: [
        'Di <b>Microsoft Entra ID</b>, buka <b>App registrations</b> lalu <b>New registration</b>. Catat <b>Tenant ID</b> dan <b>Client ID</b>.',
        'Di aplikasi itu, buka <b>Certificates and secrets</b>, buat <b>Client secret</b>, lalu salin <b>Value</b>-nya saat itu juga.',
        'Buka <b>Subscriptions</b>, pilih subscription, lalu <b>Access control (IAM)</b> dan <b>Add role assignment</b>. Beri peran <b>Reader</b> (untuk daftar VM) dan <b>Cost Management Reader</b> (untuk tagihan) ke aplikasi tadi.',
        'Tempel keempat nilai ke form.',
      ],
      env: 'FINOPS_AZURE_TENANT_ID, FINOPS_AZURE_CLIENT_ID, FINOPS_AZURE_CLIENT_SECRET, dan FINOPS_AZURE_SUBSCRIPTION_ID',
    },
    gcp: {
      title: 'Google Cloud',
      intro: 'Membaca daftar VM Compute Engine dengan service account read-only. Tagihan asli bisa ditambahkan lewat ekspor penagihan BigQuery.',
      cost: 'Daftar VM gratis. Kalau tabel tagihan diisi, setiap sinkron menjalankan satu query BigQuery yang dibatasi 2 GB data. Sinkron otomatis sekali sehari, manual paling cepat tiap 10 menit.',
      fields: [
        { k: 'serviceAccountJson', label: 'Kunci service account (isi file JSON)', ph: '{ "type": "service_account", ... }', type: 'textarea', secret: true },
        { k: 'table', label: 'Tabel ekspor penagihan BigQuery (opsional)', ph: 'proyek-saya.billing.gcp_billing_export_v1_XXXXXX', type: 'text', keep: true },
      ],
      steps: [
        'Di <b>IAM &amp; Admin</b>, buka <b>Service Accounts</b>, buat service account baru, lalu buat <b>kunci JSON</b> dan unduh.',
        'Beri service account itu peran <b>Compute Viewer</b> pada project.',
        'Tempel isi file JSON ke form. Daftar VM langsung bisa dibaca.',
        'Opsional untuk tagihan asli: di <b>Billing</b>, buka <b>Billing export</b> dan aktifkan <b>Standard usage cost</b> ke dataset BigQuery. Beri peran <b>BigQuery Data Viewer</b> pada dataset dan <b>BigQuery Job User</b> pada project, lalu isi nama tabelnya.',
      ],
      env: 'FINOPS_GCP_SERVICE_ACCOUNT_JSON dan FINOPS_GCP_BILLING_TABLE',
    },
  };
  const STATE = { running: 'running', stopped: 'stopped' };

  function serversHtml(list) {
    if (!list.length) return '<p class="muted">Belum ada server. Klik Sinkronkan setelah kredensial tersimpan.</p>';
    return `<div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Server</th><th scope="col">Lokasi</th><th scope="col">Tipe</th><th scope="col">Spesifikasi</th><th scope="col">Status</th><th scope="col" class="num">Per bulan</th></tr></thead><tbody>${list
      .map((s) => `<tr><td>${esc(s.name)}<br><span class="muted">${esc(s.id.split('/').pop())}</span></td><td>${esc(s.location)}</td><td><code>${esc(s.type)}</code></td><td>${s.vcpu ? `${s.vcpu} vCPU, ${s.memGiB} GiB, ` : ''}${s.diskGB} GB disk</td><td><span class="status s-${esc(s.state)}">${esc(STATE[s.state] || s.state)}</span></td><td class="num">${usd(s.monthly)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  }

  async function renderCloud(main, tabs, id) {
    const def = DEFS[id];
    const s = await api('GET', `/api/cloud/${id}`);
    const sum = s.summary;
    const errs = [s.serversError && `Daftar server: ${s.serversError}`, s.billingError && `Tagihan: ${s.billingError}`, s.lastError].filter(Boolean);
    const status = s.configured
      ? `<p>Tersambung sebagai <code>${esc(s.keyHint)}</code>${s.fromEnv ? ' (dari environment variable)' : ''}. ${s.lastSync ? `Sinkron terakhir ${esc(fmtTime(s.lastSync))}.` : 'Belum pernah sinkron.'} ${esc(s.serverCount)} server, ${esc(s.dayCount)} hari tagihan.</p>${errs.map((e) => `<p class="err" role="alert">${esc(e)}</p>`).join('')}`
      : '<p class="muted">Belum tersambung. Isi kredensial read-only di bawah.</p>';
    const fields = def.fields
      .map((f) => {
        const cur = f.k === 'regions' ? (s.regions || []).join(', ') : f.k === 'table' ? s.table || '' : '';
        const ph = s.configured && f.secret ? 'tersimpan. Isi untuk mengganti.' : f.ph;
        const dis = s.fromEnv ? 'disabled' : '';
        return f.type === 'textarea'
          ? `<label>${esc(f.label)}<textarea data-k="${f.k}" rows="5" autocomplete="off" spellcheck="false" placeholder="${esc(ph)}" ${dis}></textarea></label>`
          : `<label>${esc(f.label)}<input data-k="${f.k}" type="${f.type}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(cur)}" ${dis}></label>`;
      })
      .join('');
    const billHtml = sum && sum.billed
      ? `<section class="section"><h2>Tagihan server, 30 hari terakhir</h2>
          ${C.line({ rows: sum.series.map((d) => ({ date: d.date.slice(5), v: d.total })), label: `Tagihan harian ${def.title}`, height: 170 })}
          ${sum.services.length ? `<div style="margin-top:14px">${C.hbars({ rows: sum.services.slice(0, 6).map((x) => ({ label: x.name, value: x.amount })), label: `Tagihan per layanan ${def.title}` })}</div>` : ''}
          <p class="muted">Hanya layanan yang berkaitan dengan server (compute, disk, jaringan). Data terbaru ${esc(sum.lastDate)}.</p></section>`
      : '';
    const body = `${tabs}
      <div class="intro">${L.badge(id, 'logo lg')}<p class="muted">${esc(def.intro)}</p></div>
      <div class="note"><b>Biaya dan batas:</b> ${esc(def.cost)}</div>
      <section class="box"><h2>Sambungan</h2>${status}
        <form id="cloudForm" style="display:grid;gap:10px;max-width:620px;margin-top:10px">${fields}
          <p class="err" id="cloudErr" role="alert"></p>
          <div class="row"><button class="btn primary" type="submit" ${s.fromEnv ? 'disabled' : ''}>Simpan</button><button class="btn" type="button" id="cloudSync" ${s.configured ? '' : 'disabled'}>Sinkronkan</button>${s.configured && !s.fromEnv ? '<button class="btn danger" type="button" id="cloudClear">Putuskan</button>' : ''}<span id="cloudResult" role="status"></span></div>
        </form></section>
      ${s.configured ? `<section class="section"><h2>Server terdaftar (${esc(s.servers.length)})</h2>${serversHtml(s.servers)}</section>` : ''}
      ${billHtml}
      <section class="section"><h2>Cara menyiapkan kredensial read-only</h2>
        <ol class="steps">${def.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
        ${def.policy ? `<p>Kebijakan IAM minimal (read-only):</p>${codeBox(def.policy)}` : ''}
        <p class="muted" style="margin-top:10px">Rahasia disimpan di server dan tidak pernah dikirim balik ke browser. Untuk deployment, lebih aman memakai environment variable ${esc(def.env)}.</p>
      </section>`;
    main.innerHTML = pageHtml('Integrations', '', body);
    C.bind(main);

    const result = $('#cloudResult');
    $('#cloudForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#cloudErr').textContent = '';
      const payload = {};
      for (const f of def.fields) payload[f.k] = main.querySelector(`[data-k="${f.k}"]`).value;
      try {
        await api('PUT', `/api/cloud/${id}`, payload);
        toast('Tersimpan');
        renderCloud(main, tabs, id);
      } catch (err) {
        $('#cloudErr').textContent = err.message;
      }
    });
    $('#cloudSync').addEventListener('click', async (e) => {
      e.target.disabled = true;
      result.textContent = `Membaca data dari ${def.title}...`;
      try {
        const r = await api('POST', `/api/cloud/${id}/sync`);
        if (r.error) {
          result.innerHTML = `<span class="s-alert">Gagal: ${esc(r.error)}</span>`;
          e.target.disabled = false;
        } else {
          toast('Sinkron selesai');
          renderCloud(main, tabs, id);
          A.refreshBalance();
        }
      } catch (err) {
        result.innerHTML = `<span class="s-alert">${esc(err.message)}</span>`;
        e.target.disabled = false;
      }
    });
    const clr = $('#cloudClear');
    if (clr)
      clr.addEventListener('click', () =>
        confirmInline(clr, 'Yakin ingin hapus?', 'Ya, putuskan', async () => {
          await api('PUT', `/api/cloud/${id}`, { clear: true });
          toast('Sambungan diputus');
          renderCloud(main, tabs, id);
          A.refreshBalance();
        })
      );
  }

  window.App.renderCloudTab = renderCloud;

  // ---------- Artifacts: pilih banyak lalu hapus ----------
  async function artifacts(main, id) {
    if (id) return window.App.renderArtifactDetail(main, id);
    const list = await api('GET', '/api/artifacts');
    const body = list.length
      ? `<div class="bulkbar"><label class="row" style="gap:8px;color:var(--text)"><input type="checkbox" id="selAll"> Pilih semua</label><span class="muted" id="selCount">0 dipilih</span><button class="btn small danger" type="button" id="delSel" disabled>Hapus yang dipilih</button></div>
         <div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col" class="checkcol"><span class="sr-only">Pilih</span></th><th scope="col">Judul</th><th scope="col">Sumber</th><th scope="col">Dibuat</th></tr></thead><tbody>${list
           .map((a) => `<tr><td class="checkcol"><input type="checkbox" data-sel="${esc(a.id)}" aria-label="Pilih ${esc(a.title)}"></td><td><a href="#/artifacts/${esc(a.id)}">${esc(a.title)}</a></td><td>${esc(a.source.split(':')[0])}</td><td>${esc(fmtTime(a.ts))}</td></tr>`)
           .join('')}</tbody></table></div>`
      : '<p class="muted">Belum ada artifact. Klik "Simpan sebagai artifact" di bawah jawaban agent, atau jalankan sebuah automation.</p>';
    main.innerHTML = pageHtml('Artifacts', '<span class="muted">Laporan tersimpan dari chat dan automation</span>', body);
    if (!list.length) return;
    const boxes = () => [...main.querySelectorAll('[data-sel]')];
    const upd = () => {
      const n = boxes().filter((b) => b.checked).length;
      $('#selCount').textContent = `${n} dipilih`;
      $('#delSel').disabled = n === 0;
      $('#selAll').checked = n === list.length;
    };
    main.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('change', upd));
    $('#selAll').addEventListener('change', (e) => { boxes().forEach((b) => (b.checked = e.target.checked)); upd(); });
    $('#delSel').addEventListener('click', (e) =>
      confirmInline(e.currentTarget, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
        const ids = boxes().filter((b) => b.checked).map((b) => b.dataset.sel);
        await api('POST', '/api/artifacts/delete', { ids });
        toast(`${ids.length} artifact dihapus`);
        artifacts(main);
      })
    );
  }
  window.Pages.artifacts = artifacts;
})();
