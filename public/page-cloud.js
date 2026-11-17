'use strict';
// Tab Integrations untuk AWS, Azure, dan Google Cloud. Ketiganya memakai pola yang sama:
// kredensial baca-saja, sinkron manual (dibatasi), laporan, dan petunjuk langkah demi langkah.
// Juga menggantikan halaman Artifacts agar bisa dihapus satu per satu atau sekaligus.
(function () {
  const A = window.App;
  const { $, esc, usd, api, toast, pageHtml, confirmInline, codeBox, fmtTime } = A;
  const C = window.Charts;
  const L = window.Logos;

  const DEFS = {
    aws: {
      title: 'Akun AWS',
      intro: 'Menarik tagihan AWS yang sebenarnya lewat Cost Explorer (hanya baca). Data AWS tertunda sampai 24 jam.',
      cost: 'AWS menagih $0.01 per halaman hasil Cost Explorer. Aplikasi menyinkronkan otomatis sekali sehari dan membatasi sinkron manual paling cepat tiap 10 menit, jadi biayanya sekitar satu sen per hari.',
      fields: [
        { k: 'accessKeyId', label: 'Access key ID', ph: 'AKIA…', type: 'text' },
        { k: 'secretAccessKey', label: 'Secret access key', ph: 'tempel secret access key', type: 'password' },
      ],
      steps: [
        'Buka AWS Console, lalu <b>Billing and Cost Management</b>. Di <b>Cost Explorer</b>, klik <b>Launch Cost Explorer</b> kalau belum pernah dibuka. AWS butuh sampai 24 jam menyiapkan data pertama.',
        'Buka <b>IAM</b>, buat user baru tanpa akses console, lalu pasang kebijakan di bawah.',
        'Di user itu, buat <b>Access key</b> (use case: Application running outside AWS), lalu tempel ke form.',
      ],
      policy: '{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Action": "ce:GetCostAndUsage", "Resource": "*" }\n  ]\n}',
      env: 'FINOPS_AWS_ACCESS_KEY_ID dan FINOPS_AWS_SECRET_ACCESS_KEY',
    },
    azure: {
      title: 'Azure',
      intro: 'Menarik biaya Azure yang sebenarnya lewat Cost Management Query API (hanya baca) memakai service principal. Data Azure bisa tertunda beberapa jam.',
      cost: 'Query Cost Management tidak ditagih, tetapi Azure membatasi jumlah permintaan. Aplikasi menyinkronkan otomatis sekali sehari dan membatasi sinkron manual paling cepat tiap 10 menit.',
      fields: [
        { k: 'tenantId', label: 'Tenant ID', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'clientId', label: 'Client ID (Application ID)', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'subscriptionId', label: 'Subscription ID', ph: '00000000-0000-0000-0000-000000000000', type: 'text' },
        { k: 'clientSecret', label: 'Client secret', ph: 'tempel nilai secret', type: 'password' },
      ],
      steps: [
        'Di <b>Microsoft Entra ID</b>, buka <b>App registrations</b> lalu <b>New registration</b>. Catat <b>Tenant ID</b> dan <b>Client ID</b>.',
        'Di aplikasi itu, buka <b>Certificates and secrets</b>, buat <b>Client secret</b>, lalu salin <b>Value</b>-nya saat itu juga (hanya tampil sekali).',
        'Buka <b>Subscriptions</b>, pilih subscription kamu, lalu <b>Access control (IAM)</b> dan <b>Add role assignment</b>. Beri peran <b>Cost Management Reader</b> kepada aplikasi tadi, lalu catat <b>Subscription ID</b>.',
        'Tempel keempat nilai ke form.',
      ],
      env: 'FINOPS_AZURE_TENANT_ID, FINOPS_AZURE_CLIENT_ID, FINOPS_AZURE_CLIENT_SECRET, dan FINOPS_AZURE_SUBSCRIPTION_ID',
    },
    gcp: {
      title: 'Google Cloud',
      intro: 'Membaca biaya Google Cloud dari ekspor penagihan di BigQuery (hanya baca). Google tidak punya API biaya langsung, jadi ekspor harus diaktifkan dulu.',
      cost: 'Setiap sinkron menjalankan satu query BigQuery yang dibatasi 2 GB data. Aplikasi menyinkronkan otomatis sekali sehari dan membatasi sinkron manual paling cepat tiap 10 menit.',
      fields: [
        { k: 'table', label: 'Tabel ekspor penagihan', ph: 'proyek-saya.billing.gcp_billing_export_v1_XXXXXX', type: 'text' },
        { k: 'serviceAccountJson', label: 'Kunci service account (isi file JSON)', ph: '{ "type": "service_account", … }', type: 'textarea' },
      ],
      steps: [
        'Di <b>Billing</b>, buka <b>Billing export</b>, lalu aktifkan <b>Standard usage cost</b> ke sebuah dataset BigQuery. Data baru mulai terisi setelah ekspor aktif, dan tidak ada data lama yang diisi ulang.',
        'Di <b>IAM &amp; Admin</b> buka <b>Service Accounts</b>, buat service account baru, lalu buat <b>kunci JSON</b> dan unduh.',
        'Beri service account itu peran <b>BigQuery Data Viewer</b> pada dataset ekspor dan <b>BigQuery Job User</b> pada project.',
        'Salin nama tabel (project.dataset.tabel) dan tempel isi file JSON ke form.',
      ],
      env: 'FINOPS_GCP_SERVICE_ACCOUNT_JSON dan FINOPS_GCP_BILLING_TABLE',
    },
  };

  async function renderCloud(main, tabs, id) {
    const def = DEFS[id];
    const s = await api('GET', `/api/cloud/${id}`);
    const sum = s.summary;
    const reportHtml = sum
      ? `<section class="section"><h2>Tagihan ${esc(def.title)}, 30 hari terakhir</h2>
          <dl class="facts" style="max-width:440px;margin-bottom:14px">
            <div><dt>Total 30 hari</dt><dd>${esc(usd(sum.total))} ${esc(s.currency)}</dd></div>
            <div><dt>Bulan ini</dt><dd>${esc(usd(sum.mtd))} ${esc(s.currency)}</dd></div>
            <div><dt>Perkiraan akhir bulan</dt><dd>${esc(usd(sum.forecastMonth))}<small>dari rata-rata 7 hari terakhir</small></dd></div>
            <div><dt>Data terbaru</dt><dd>${esc(sum.lastDate)}</dd></div>
          </dl>
          ${C.line({ rows: sum.series.map((d) => ({ date: d.date, v: d.total })), label: `Biaya harian ${def.title}, 30 hari terakhir` })}
          <div style="margin-top:14px">${C.donut({ slices: sum.services.slice(0, 6).map((x) => ({ label: x.name, value: x.amount })), label: `Porsi biaya per layanan ${def.title}`, center: { top: usd(sum.total), bottom: '30 hari' } })}</div>
          <details class="data"><summary>Lihat data dalam tabel</summary><div class="tbl-wrap" tabindex="0"><table><thead><tr><th scope="col">Layanan</th><th scope="col" class="num">Biaya</th></tr></thead><tbody>${sum.services.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${esc(usd(x.amount))}</td></tr>`).join('')}</tbody></table></div></details></section>`
      : s.configured
        ? '<p class="muted">Kredensial tersimpan, tetapi belum ada data. Klik Sinkronkan sekarang.</p>'
        : '';
    const status = s.configured
      ? `<p>Tersambung sebagai <code>${esc(s.keyHint)}</code>${s.fromEnv ? ' (dari environment variable)' : ''}. ${s.lastSync ? `Sinkronisasi terakhir ${esc(fmtTime(s.lastSync))}.` : 'Belum pernah sinkron.'} Permintaan API dipakai: ${esc(s.requests)}.</p>${s.lastError ? `<p class="err" role="alert">${esc(s.lastError)}</p>` : ''}`
      : '<p class="muted">Belum tersambung. Isi kredensial baca-saja di bawah.</p>';
    const fields = def.fields
      .map((f) => {
        const ph = s.configured && f.type === 'password' ? 'tersimpan. Isi untuk mengganti.' : f.ph;
        return f.type === 'textarea'
          ? `<label>${esc(f.label)}<textarea data-k="${f.k}" rows="5" autocomplete="off" spellcheck="false" placeholder="${esc(s.configured ? 'tersimpan. Tempel kunci baru untuk mengganti.' : ph)}" ${s.fromEnv ? 'disabled' : ''}></textarea></label>`
          : `<label>${esc(f.label)}<input data-k="${f.k}" type="${f.type}" autocomplete="off" placeholder="${esc(ph)}" ${s.fromEnv ? 'disabled' : ''}></label>`;
      })
      .join('');
    const body = `${tabs}
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:6px">${L.badge(id, 'logo')}<p class="muted" style="margin:0;max-width:680px">${esc(def.intro)} Data ini tidak mengurangi anggaran dan tidak masuk estimasi VPS.</p></div>
      <div class="note"><b>Biaya dan batas:</b> ${esc(def.cost)}</div>
      <section class="box"><h2>Sambungan</h2>${status}
        <form id="cloudForm" style="display:grid;gap:10px;max-width:620px;margin-top:10px">${fields}
          <p class="err" id="cloudErr" role="alert"></p>
          <div class="row"><button class="btn primary" type="submit" ${s.fromEnv ? 'disabled' : ''}>Simpan kredensial</button><button class="btn" type="button" id="cloudSync" ${s.configured ? '' : 'disabled'}>Sinkronkan sekarang</button>${s.configured && !s.fromEnv ? '<button class="btn danger" type="button" id="cloudClear">Hapus kredensial</button>' : ''}<span id="cloudResult" role="status"></span></div>
        </form></section>
      ${reportHtml}
      <section class="section"><h2>Cara menyiapkan kredensial baca-saja</h2>
        <ol class="steps">${def.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
        ${def.policy ? `<p>Kebijakan IAM minimal, hanya boleh membaca biaya:</p>${codeBox(def.policy)}` : ''}
        <p class="muted" style="margin-top:10px">Rahasia disimpan di server dan tidak pernah dikirim balik ke browser. Untuk deployment, lebih aman memakai environment variable ${esc(def.env)}.</p>
      </section>
      <section class="section"><h2>Ekspor tanpa terkunci vendor</h2>
        <p>Semua biaya (agent VPS, AWS, Azure, Google Cloud) bisa diunduh dengan nama kolom <b>FOCUS</b> (FinOps Open Cost and Usage Specification), standar terbuka yang sama dipakai ketiga vendor. File ini memuat subset kolom FOCUS, dan kolom tambahan diawali <code>x_</code>. VPS sample AWS tidak diekspor karena hanya proyeksi.</p>
        <a class="btn" href="/api/export/focus.csv" download style="display:inline-flex;align-items:center;text-decoration:none">Unduh CSV FOCUS</a>
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
        toast('Kredensial tersimpan');
        renderCloud(main, tabs, id);
      } catch (err) {
        $('#cloudErr').textContent = err.message;
      }
    });
    $('#cloudSync').addEventListener('click', async (e) => {
      e.target.disabled = true;
      result.textContent = `Menarik data dari ${def.title}…`;
      try {
        const r = await api('POST', `/api/cloud/${id}/sync`);
        if (r.error) {
          result.innerHTML = `<span class="s-alert">Gagal: ${esc(r.error)}</span>`;
          e.target.disabled = false;
        } else {
          toast('Sinkronisasi selesai');
          renderCloud(main, tabs, id);
        }
      } catch (err) {
        result.innerHTML = `<span class="s-alert">${esc(err.message)}</span>`;
        e.target.disabled = false;
      }
    });
    const clr = $('#cloudClear');
    if (clr)
      clr.addEventListener('click', () =>
        confirmInline(clr, 'Yakin ingin hapus?', 'Ya, hapus', async () => {
          await api('PUT', `/api/cloud/${id}`, { clear: true });
          toast('Kredensial dihapus');
          renderCloud(main, tabs, id);
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
