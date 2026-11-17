# VPS FinOps Agent

Dashboard FinOps untuk VPS dan akun cloud. Biaya VPS dihitung dari pemakaian nyata dengan harga AWS us-east-1 on-demand. Tagihan asli dari AWS, Azure, dan Google Cloud ditarik lewat API baca-saja. Semuanya tampil terpusat, bisa direncanakan tanpa server, dan bisa diekspor dengan kolom FOCUS.

## Fitur

| Fitur | Isi |
|---|---|
| Ringkasan | Perkiraan biaya akhir bulan, grafik harian dan kumulatif dengan forecast harian, filter sumber dan rentang, rincian per layanan |
| Sumber data | VPS (agent), AWS Cost Explorer, Azure Cost Management, Google Cloud (ekspor BigQuery) |
| Perencanaan | Hitung biaya dari daftar sumber daya (EC2, EBS, S3, data transfer, NAT Gateway, load balancer) tanpa server asli dan tanpa biaya. Rencana bisa disimpan dan dibandingkan |
| Anggaran | Uang yang kamu sediakan untuk biaya server. Bisa ditambah, dikurangi, atau ditetapkan ulang |
| Chat agent | Jawaban dengan grafik, kartu angka, dan tombol pertanyaan lanjutan. Model AI opsional dengan cadangan |
| Automations | Cek anomali harian, peringatan budget, review rightsizing |
| Artifacts | Laporan tersimpan, bisa dihapus satu per satu atau sekaligus |
| Ekspor | CSV dengan nama kolom FOCUS, tidak terkunci pada satu vendor |

## Deploy ke Vercel

1. Push folder ini ke GitHub.
2. Di Vercel: **Add New, Project, Import** repository. Application Preset: **Other**, kolom build dikosongkan.
3. **Storage, Create Database, Upstash for Redis** (Free), prefix `KV`, lalu hubungkan ke project.
4. **Settings, Environment Variables**: `ADMIN_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`.
5. **Deployments, Redeploy**.

Tanpa Redis, data di Vercel hilang di antara permintaan.

## Jalankan lokal

Butuh Node.js 18 atau lebih baru, tanpa `npm install`.

```cmd
npm start
```

Buka http://localhost:8080. Password bawaan `admin123`. Data lokal ada di `data/db.json`.

## Menyambungkan sumber

Semua ada di **Integrations**, dengan petunjuk langkah demi langkah di tiap tab.

| Sumber | Akses yang dibutuhkan | Catatan |
|---|---|---|
| VPS | Perintah install agent (systemd, bash, curl) | Agent hanya membaca CPU, RAM, disk, network |
| AWS | User IAM dengan `ce:GetCostAndUsage` | AWS menagih sekitar $0.01 per halaman hasil. Sinkron otomatis sekali sehari |
| Azure | Service principal dengan peran Cost Management Reader | Data tertunda beberapa jam |
| Google Cloud | Service account (BigQuery Data Viewer dan Job User) dan tabel ekspor penagihan | Ekspor harus diaktifkan dulu, data lama tidak diisi ulang |

Sinkron manual dibatasi paling cepat tiap 10 menit. Kredensial disimpan di server dan tidak pernah dikirim balik ke browser.

## Environment variable

| Variable | Fungsi |
|---|---|
| `ADMIN_PASSWORD` | Password login (bawaan `admin123`) |
| `SESSION_SECRET` | Penanda tangan cookie sesi |
| `CRON_SECRET` | Melindungi `/api/cron` di Vercel |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis (diisi otomatis oleh integrasi Vercel) |
| `PUBLIC_URL` | Alamat dashboard di perintah install agent |
| `AI_PRIMARY_API_KEY`, `AI_BACKUP_API_KEY` | Kunci model AI, menimpa nilai dari UI |
| `FINOPS_AWS_ACCESS_KEY_ID`, `FINOPS_AWS_SECRET_ACCESS_KEY` | Kredensial AWS |
| `FINOPS_AZURE_TENANT_ID`, `FINOPS_AZURE_CLIENT_ID`, `FINOPS_AZURE_CLIENT_SECRET`, `FINOPS_AZURE_SUBSCRIPTION_ID` | Kredensial Azure |
| `FINOPS_GCP_SERVICE_ACCOUNT_JSON`, `FINOPS_GCP_BILLING_TABLE` | Kredensial Google Cloud |

## Model biaya VPS

| Komponen | Tarif (us-east-1) |
|---|---|
| EC2 | Instance yang paling pas dengan vCPU dan RAM VPS, arsitektur sama |
| EBS gp3 | $0.08 per GB-bulan |
| Public IPv4 | $0.005 per jam |
| Data transfer keluar | 100 GB per bulan gratis, lalu $0.09 per GB |

Harga adalah salinan statis di `lib/pricing.js` dan `lib/cloud.js`. Cek ulang di halaman harga AWS sebelum dipakai untuk keputusan.

Estimasi VPS bukan tagihan. Tagihan asli hanya muncul dari sumber AWS, Azure, dan Google Cloud, dan keduanya ditampilkan terpisah.
