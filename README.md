# VPS FinOps Agent

Dashboard FinOps untuk server di AWS (EC2), Azure (Virtual Machines), dan Google Cloud (Compute Engine). Daftar server dan bills dibaca lewat API read-only milik tiap platform, lalu ditampilkan dalam satu dashboard. Biaya server juga bisa direncanakan di Planning.

## Fitur

| Fitur | Isi |
|---|---|
| Dashboard | Perkiraan biaya akhir bulan, empat grafik sekaligus (biaya harian per platform, kumulatif vs budget, porsi platform, server terbesar), tombol Refresh, tabel penggunaan per platform, daftar server, peluang hemat, lonjakan bills |
| Server terdaftar | Diambil otomatis dari EC2, Azure VM, dan Compute Engine. Tidak ada server yang ditambah manual |
| Planning | Rekomendasi spesifikasi dari budget dan kebutuhan (jenis aplikasi, kunjungan, data), atau susun sendiri lintas platform. Rencana bisa disimpan, dibandingkan, dan diunduh |
| Budget | Uang yang kamu sediakan per bulan untuk biaya server. Bisa ditambah, dikurangi, atau ditetapkan |
| Chat agent | Jawaban dengan grafik, kartu angka, dan tombol pertanyaan lanjutan. Model AI opsional dengan cadangan |
| Automations | Cek lonjakan harian, peringatan budget, review hemat mingguan |
| Artifacts | Laporan tersimpan, bisa dihapus satu per satu atau sekaligus |

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

## Menyambungkan platform

Semua ada di **Integrations**, dengan langkah penyiapan di tiap tab.

| Platform | Akses read-only | Catatan |
|---|---|---|
| AWS | User IAM dengan `ec2:DescribeInstances`, `ec2:DescribeVolumes`, `ce:GetCostAndUsage` | Server di us-east-1. Buka Cost Explorer sekali supaya bills tersedia (sampai 24 jam) |
| Azure | Service principal dengan peran Reader dan Cost Management Reader | Data bills tertunda beberapa jam |
| Google Cloud | Service account dengan peran Compute Viewer | Bills asli opsional lewat ekspor penagihan BigQuery |

Setelah kredensial disimpan, server langsung dibaca. Status server (running atau stopped) diperbarui setiap menit selama dashboard dibuka. Bills diperbarui sekali sehari. Semua platform memakai region US East: AWS us-east-1, Azure East US, Google Cloud us-east1.

## Environment variable

| Variable | Fungsi |
|---|---|
| `ADMIN_PASSWORD` | Password login (bawaan `admin123`) |
| `SESSION_SECRET` | Penanda tangan cookie sesi |
| `CRON_SECRET` | Melindungi `/api/cron` di Vercel |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis (diisi otomatis oleh integrasi Vercel) |
| `AI_PRIMARY_API_KEY`, `AI_BACKUP_API_KEY` | Kunci model AI, menimpa nilai dari UI |
| `FINOPS_AWS_ACCESS_KEY_ID`, `FINOPS_AWS_SECRET_ACCESS_KEY` | Kredensial AWS |
| `FINOPS_AZURE_TENANT_ID`, `FINOPS_AZURE_CLIENT_ID`, `FINOPS_AZURE_CLIENT_SECRET`, `FINOPS_AZURE_SUBSCRIPTION_ID` | Kredensial Azure |
| `FINOPS_GCP_SERVICE_ACCOUNT_JSON`, `FINOPS_GCP_BILLING_TABLE` | Kredensial Google Cloud dan tabel bills (opsional) |

## Cara angka dihitung

| Angka | Sumber |
|---|---|
| Biaya per server | Daftar harga on-demand Linux (`lib/pricing.js`): compute per jam x 730, disk per GB, satu IPv4 publik. Server stopped hanya membayar disk |
| Biaya bulan berjalan | Bills asli kalau tersedia (hanya layanan compute, disk, dan jaringan). Kalau belum ada, estimasi dari daftar server |
| Perkiraan akhir bulan | Bulan berjalan + rata-rata bills 7 hari (atau estimasi harian) x hari tersisa |
| Rekomendasi Planning | Aturan tetap per jenis aplikasi untuk kebutuhan vCPU dan RAM, lalu tipe server terkecil yang memenuhi di tiap platform |

Harga on-demand region US East, disimpan di `lib/pricing.js`.

Logo AWS, Azure, dan Google Cloud memakai bentuk dari simple-icons dengan warna palet web ini. Proyek ini untuk tugas kuliah, bukan produk komersial.
