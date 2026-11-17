# DESIGN.md

Arahan desain untuk FinOps Agent. Isinya dicatat dari permintaan pemilik proyek di chat. Agen hanya memformat, tidak menambah arah baru.

## Identitas

Dashboard FinOps untuk server terdaftar di AWS, Azure, dan Google Cloud. Dipakai mahasiswa dan dosen untuk memeriksa biaya, forecast, lonjakan, peluang hemat, dan rekomendasi spesifikasi. Teks UI hanya menampilkan yang perlu diketahui pengguna. Logo platform memakai bentuk resmi dengan warna palet web (tugas kuliah, non-komersial). Ini alat kerja, bukan halaman pemasaran, jadi tidak ada hero, testimoni, atau angka hiasan.

## Arahan dari pemilik

- Warna tidak boleh sama persis dengan referensi, tetapi tetap classy.
- Gaya tidak terlalu mirip referensi. Posisi elemen tetap: top bar di atas, sidebar di kiri, area chat di tengah, kotak input di bawah.
- Font: system sans, bukan serif.
- Bahasa Indonesia. Istilah IT tetap English.
- Tidak memakai popup konfirmasi browser. Konfirmasi tampil di tempat ("Yakin ingin hapus?").
- Tidak boleh ada kata "simulasi" atau "demo" di UI.

## Palet

Dua warna inti netral (grafit gelap dan krem terang) dan satu aksen emas champagne. Palet ini dibawa dari versi sebelumnya yang sudah dilihat pemilik. Ganti nilai di `public/style.css` (bagian `:root` dan `.light`) kalau mau warna lain.

| Peran | Gelap | Terang |
|---|---|---|
| Latar | #121315 | #f7f5f0 |
| Teks | #ecebe7 | #24221d |
| Aksen | #c9a96e | #8a6a2a |

Aksen dipakai hanya untuk tombol utama, cincin fokus, penanda tab aktif, saklar aktif, dan satu seri pada grafik.

## Tipografi

System sans (`system-ui`, Segoe UI di Windows). Alasan: permintaan pemilik, dan terbaca baik untuk tabel angka. Angka memakai `tabular-nums` supaya kolom sejajar.

## Dial

ENERGY 1 / RHYTHM 2 / MOTION 1

- ENERGY 1: alat kerja yang tenang, fokus pada angka.
- RHYTHM 2: halaman Ringkasan punya satu titik fokus (forecast), halaman lain mengikuti komposisi yang sama.
- MOTION 1: hanya transisi hover dan fokus. Tidak ada animasi berulang.

## Titik fokus per halaman

- Ringkasan: angka forecast bulan ini beserta posisinya terhadap budget.
- Chat: jawaban agent terbaru.
- Integrations: kredensial read-only per platform dan daftar server terdaftar.
- Planning: form budget dan kebutuhan, hasil rekomendasi spesifikasi.
