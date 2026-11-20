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

## Permukaan dan grafik

- Panel datar dengan garis tipis. Bayangan hanya untuk yang melayang: tooltip, dialog, toast, menu HP.
- Dua radius: 6px kontrol, 10px panel. Kapsul hanya untuk saklar.
- Tanpa gradasi, glow, atau blur dekoratif.
- Judul grafik ditulis sebagai pertanyaan yang dijawab grafiknya.
- Grafik garis menandai nilai terakhir langsung di garis; perkiraan bergaris putus-putus setelah "hari ini".
- Donat bercincin tipis dengan celah antar irisan; legenda berupa daftar bergaris.

## Dial

ENERGY 1 / RHYTHM 2 / MOTION 2

- ENERGY 1: alat kerja yang tenang, fokus pada angka.
- RHYTHM 2: Dashboard punya satu titik fokus (kartu total bill dengan tren kecil), halaman lain mengikuti komposisi yang sama.
- MOTION 2 (diminta pemilik: UI lebih modern dengan animasi). Setiap gerak punya tugas dan hanya jalan sekali:
  - konten halaman naik pelan saat halaman dibuka,
  - garis grafik digambar dari kiri (arah waktu), batang dan meter tumbuh dari nol (besaran),
  - angka total naik dari nol satu kali saat Dashboard pertama dibuka,
  - ikon Refresh berputar hanya selama memuat.
  Tidak ada animasi berulang tanpa pemicu. Semua mati kalau perangkat meminta gerak dikurangi.

## Logo dan ikon

- Logo produk: ubin emas berisi tiga rak server yang memanjang seperti batang biaya naik.
- Ikon menu: satu set garis 1.6px buatan sendiri, dipakai di sidebar dan tombol topbar. Teks tetap tampil di samping ikon.

## Titik fokus per halaman

- Ringkasan: angka forecast bulan ini beserta posisinya terhadap budget.
- Chat: jawaban agent terbaru.
- Integrations: kredensial read-only per platform dan daftar server terdaftar.
- Planning: form budget dan kebutuhan, hasil rekomendasi spesifikasi.
