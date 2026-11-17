'use strict';
// Logo produk dan lencana sumber. Semuanya SVG buatan sendiri: tanda abstrak sederhana, bukan logo resmi vendor
// (logo vendor adalah merek dagang). Warna mengikuti tema lewat variabel CSS.
(function () {
  // Produk: tiga batang naik di dalam persegi bersudut, sebagai kiasan grafik biaya.
  const product = (cls = 'logo') =>
    `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="none" stroke="var(--accent)" stroke-width="2"/><rect x="8" y="17" width="4" height="8" fill="var(--accent)"/><rect x="14" y="12" width="4" height="13" fill="var(--accent)"/><rect x="20" y="7" width="4" height="18" fill="var(--accent)"/></svg>`;

  const BADGES = {
    // Server dengan dua garis: VPS milik sendiri.
    vps: `<rect x="5" y="6" width="22" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="18" width="22" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="1.4" fill="currentColor"/><circle cx="10" cy="22" r="1.4" fill="currentColor"/>`,
    // Kotak isometrik sederhana.
    aws: `<path d="M16 4 L27 10 V22 L16 28 L5 22 V10 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 10 L16 16 L27 10 M16 16 V28" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    // Dua bidang miring yang bertumpu.
    azure: `<path d="M5 26 L14 6 H19 L11 26 Z" fill="currentColor"/><path d="M15 26 L27 26 L19 10 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    // Awan dengan satu titik.
    gcp: `<path d="M9 24 a5 5 0 0 1 .6-9.9 A7 7 0 0 1 23 12.5 A5.5 5.5 0 0 1 22.5 24 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="16" cy="19" r="1.6" fill="currentColor"/>`,
    // Kerangka rencana: garis putus-putus berbentuk persegi dengan tanda tambah.
    plan: `<rect x="5" y="5" width="22" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/><path d="M16 11 V21 M11 16 H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  };
  const badge = (id, cls = 'logo') => `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false" style="color:var(--text)">${BADGES[id] || BADGES.vps}</svg>`;

  window.Logos = { product, badge };
})();
