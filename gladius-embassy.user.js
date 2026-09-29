// ==UserScript==
// @name         GetEmbassy Gladius - Proses Otomatis
// @namespace    http://tampermonkey.net/
// @version      1.7.0
// @description  [GetEmbassy] Auto-proses antrian /embassy dan /password dari bot lokal/server langsung di halaman Gladius: isi Nomor Internet, proses Embassy atau Password Check, ambil screenshot (html2canvas), lalu kirim base64 ke server bot. Tanpa Python/Selenium/debug port.
// @author       diana
// @match        https://gladius.telkom.co.id/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      getembassybot-production.up.railway.app
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ===================== NEUTRALISER DIALOG (WAJIB PALING AWAL) =====================
  // Gladius memunculkan window.alert("... data tidak dapat ditemukan ...") saat hasil
  // kosong. Dialog NATIVE membekukan SELURUH JavaScript halaman (setTimeout, promise,
  // callback XHR) sampai diklik manual. Akibatnya script tidak bisa polling antrian
  // dan membaca halaman yang belum selesai render. Dialog native tidak bisa ditutup
  // dari JavaScript, jadi satu-satunya jalan adalah menggantinya SEBELUM script Gladius
  // memanggilnya — karena itu blok ini harus jalan di document-start, di luar gate
  // DOMContentLoaded.
  var DIALOG_MAX = 20;
  var DIALOG_LOG = [];
  var DIALOG_TERAKHIR = null; // { pesan, waktu, jenis }

  // Pola "data kosong" dari Gladius. Dipakai sebagai sinyal state, bukan ditebak dari isi sel.
  var POLA_TIDAK_DITEMUKAN = new RegExp(
    "tidak\\s+(dapat\\s+)?(di)?\\s*(t)?ditemukan" +
    "|tdak\\s+(dapat\\s+)?ditemukan" +
    "|belum\\s+ada" +
    "|tidak\\s+ada" +
    "|tidak\\s+tersedia" +
    "|not\\s+found" +
    "|no\\s+data",
    "i"
  );

  function normTeks(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function catatDialog(pesan, jenis) {
    DIALOG_TERAKHIR = { pesan: normTeks(pesan), waktu: Date.now(), jenis: jenis || "alert" };
    DIALOG_LOG.push(DIALOG_TERAKHIR);
    if (DIALOG_LOG.length > DIALOG_MAX) DIALOG_LOG.shift();
    return DIALOG_TERAKHIR;
  }

  // true bila tidak ada dialog baru dalam jendela ms terakhir.
  function dialogTua(ms) {
    if (!DIALOG_TERAKHIR) return true;
    return DIALOG_TERAKHIR.waktu <= Date.now() - (ms || 0);
  }

  // true bila dialog terakhir menyatakan data tidak ditemukan.
  function dialogMenyatakanKosong() {
    return !!(DIALOG_TERAKHIR && POLA_TIDAK_DITEMUKAN.test(DIALOG_TERAKHIR.pesan));
  }

  // Nilai yang terlalu panjang/berbentuk kalimat dianggap notifikasi, bukan nilai kolom.
  function terlihatNotifikasi(t) {
    t = normTeks(t);
    if (!t) return false;
    if (t.length > 60) return true;
    return POLA_TIDAK_DITEMUKAN.test(t);
  }

  (function pasangDialogNonBlocking() {
    try {
      window.alert = function (pesan) {
        catatDialog(pesan, "alert");
        try { console.log("[GetEmbassy] alert dicegat:", pesan); } catch (e) {}
        return undefined; // JANGAN panggil alert asli — itu yang membekukan halaman.
      };
      window.confirm = function (pesan) {
        catatDialog(pesan, "confirm");
        try { console.log("[GetEmbassy] confirm dicegat:", pesan); } catch (e) {}
        return true; // agar alur Gladius tidak tersangkut menunggu pilihan
      };
      window.prompt = function (pesan, nilaiAwal) {
        catatDialog(pesan, "prompt");
        try { console.log("[GetEmbassy] prompt dicegat:", pesan); } catch (e) {}
        return nilaiAwal == null ? "" : nilaiAwal;
      };
    } catch (e) {}
  })();

  // ===================== KONFIGURASI (edit sesuai .env / server bot) =====================
  // SERVER_BOT = URL tempat bot.py berjalan.
  //   Lokal  : "http://127.0.0.1:8080"   (PC yang sama dengan browser Gladius)
  //   Railway: "https://getembassybot-production.up.railway.app"
  // Wajib: host yang dipakai juga harus ada di @connect di metadata userscript.
  var SERVER_BOT = "http://127.0.0.1:8080";
  var RAILWAY_URL = SERVER_BOT; // alias lama (dipakai di seluruh file)
  var AGENT_SECRET = "njcdB4gEitPWyMSFVc58s388";
  var POLL_INTERVAL_DETIK = 5; // jeda polling antrian
  var WAIT_HASIL_MS = 15000; // tunggu hasil "Cek Kualitas Jaringan" stabil
  var WAIT_LFU_MS = 15000; // tunggu "Last Five Usage" selesai dimuat
  var SS_SCALE = 1; // skala screenshot (lebih kecil = file ringan, hasil ± lebar area crop)
  var SS_CROP = "auto"; // "auto" = area hasil ukur (sidebar+logo+tabel hasil+LFU) | "none" = full page
  var SS_CROP_PAD = 16; // ruang ekstra di sekeliling area hasil (px)
  var SS_CROP_OVERRIDE = null; // kalau auto meleset: isi {left, top, right, bottom}
  var SS_MASK_PASSWORD = true;

  var DAFTAR_DOMAIN = ["apps.telkom", "telkom.net", "gold.telkom", "telkom.b2b"];
  // "0" sengaja TIDAK ada di sini: 0 bisa nilai asli. "Belum dimuat" dicatat terpisah
  // lewat dialogMenyatakanKosong() supaya tidak tertukar dengan "kosong".
  var NILAI_PAKET_KOSONG = ["/", "-", "", "n/a", "na", "kosong", "null", "none"];
  var TEKS_KOLOM_PAKET = "paket radius";
  var TEKS_KOLOM_PAKET_ALT = "paket pcrf";
  var TEKS_TOMBOL_CEK = "Cek Kualitas Jaringan";
  var TEKS_TOMBOL_LFU = "Last Five Usage";
  var TEKS_TOMBOL_PASSWORD = "Check";
  var URL_EMBASSY = "https://gladius.telkom.co.id/radonline/newradonline";
  var URL_PASSWORD = "https://gladius.telkom.co.id/internetnumberr/passwordchecknew";
  var WAIT_PASSWORD_MS = 15000;
  // Reload penjaga: kalau tidak ada aktivitas apa pun selama ini, halaman di-reload
  // sekali supaya sesi login Gladius tidak kedaluwarsa saat PIC meninggalkan tab.
  var SESI_SUNYI_MS = 5 * 60 * 1000;
  // ====================================================================================

  // ===================== STATE TOLERAN RELOAD (sessionStorage) =====================
  // Halaman Gladius me-reload tiap klik Cek/LFU dan auto-refresh periodik. State di
  // sessionStorage disimpan SEBELUM tiap langkah berisiko-reload; begitu script
  // terbangun kembali sesudah reload, ia MELANJUTKAN dari langkah terakhir,
  // bukan mengulang dari nol (mencegah loop klik->reload).
  var STATE_KEY = "getembassy_state";
  var HANDLED_KEY = "getembassy_handled";
  var MAX_ATTEMPTS = 12; // batas percobaan/reload per task
  var STATE_TTL_MS = 6 * 60 * 1000;
  var HANDLED_TTL_MS = 5 * 60 * 1000;

  function simpanState(obj) {
    try {
      obj.ts = Date.now();
      sessionStorage.setItem(STATE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function bacaState() {
    try {
      var raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return null;
      var st = JSON.parse(raw);
      if (!st || !st.id) return null;
      if (Date.now() - st.ts > STATE_TTL_MS) { hapusState(); return null; }
      if (!st.jenis) st.jenis = "embassy";
      return st;
    } catch (e) { return null; }
  }

  function hapusState() {
    try { sessionStorage.removeItem(STATE_KEY); } catch (e) {}
  }

  // id task yang SUDAH selesai dikirim — cegah duplikat bila auto-refresh menyusul.
  function tandaiHandled(id) {
    try {
      var h = JSON.parse(sessionStorage.getItem(HANDLED_KEY) || "{}");
      h[id] = Date.now();
      var cut = Date.now() - HANDLED_TTL_MS;
      Object.keys(h).forEach(function (k) { if (h[k] < cut) delete h[k]; });
      sessionStorage.setItem(HANDLED_KEY, JSON.stringify(h));
    } catch (e) {}
  }

  function sudahHandled(id) {
    try {
      var h = JSON.parse(sessionStorage.getItem(HANDLED_KEY) || "{}");
      return !!h[id];
    } catch (e) { return false; }
  }

  function log(msg) {
    console.log("[GetEmbassy]", msg);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function tidur(ms) { return wait(ms); }

  function fmtWaktu() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getDate()) + "-" + p(d.getMonth() + 1) + "-" + d.getFullYear() +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // ===================== CARI ELEMEN DI HALAMAN (pola embassy.py) =====================

  function cariTeks(teks, needsInclude) {
    teks = String(teks).toLowerCase().trim().replace(/\s+/g, " ");
    if (!teks) return null;
    var tags = ["button", "a", "input", "span", "li", "div", "td"];
    var els = document.querySelectorAll(tags.join(","));
    var best = null, bestSkor = -1;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.offsetParent === null) continue;
      var t = ((el.innerText || "") + " " + (el.value || "")).replace(/\s+/g, " ").trim().toLowerCase();
      if (!t) continue;
      var exact = (t === teks);
      var inc = t.indexOf(teks) >= 0;
      if (!exact && !inc) continue;
      if (exact && t.length > teks.length * 2) continue;
      if (!exact && t.length > teks.length * (needsInclude ? 12 : 3)) continue;
      var skor = 0;
      var tag = el.tagName.toLowerCase();
      if (tag === "button" || tag === "a" || tag === "input") skor += 100;
      if (exact) skor += 50;
      else skor += 20 - Math.min(20, t.length - teks.length);
      if (el.innerText && el.innerText.trim().length <= 40) skor += 10;
      if (skor > bestSkor) { bestSkor = skor; best = el; }
    }
    return best;
  }

  function klikTeks(teks, needsInclude) {
    var el = cariTeks(teks, needsInclude);
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    try {
      el.click();
      return true;
    } catch (e) {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // Jarak pusat dua elemen (px). Dipakai sebagai pemecah seri: kolom Nomor Internet
  // selalu berdampingan dengan tombol "Cek Kualitas Jaringan".
  function jarakKe(a, b) {
    if (!a || !b) return 1e9;
    try {
      var ra = a.getBoundingClientRect();
      var rb = b.getBoundingClientRect();
      var dx = (ra.left + ra.width / 2) - (rb.left + rb.width / 2);
      var dy = (ra.top + ra.height / 2) - (rb.top + rb.height / 2);
      return Math.sqrt(dx * dx + dy * dy);
    } catch (e) {
      return 1e9;
    }
  }

  // hindari: elemen yang sudah dicoba tapi gagal diverifikasi, supaya percobaan
  // berikutnya memilih kandidat lain alih-alih mengulang kolom yang sama.
  function cariInput(hindari) {
    var anchor = cariTeks(TEKS_TOMBOL_CEK, true);
    var kandidat = [];
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (hindari && el === hindari) continue;
      if (el.offsetParent === null) continue;
      var ty = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "checkbox", "radio", "file", "image"].indexOf(ty) >= 0) continue;
      if (el.disabled || el.readOnly) continue;
      var skor = 10;
      var ph = (el.placeholder || "").toLowerCase();
      var nm = ((el.name || "") + " " + (el.id || "")).toLowerCase();
      if (/nomor|internet|no\.? ?\d|telp/.test(ph) || /nomor|internet/.test(nm)) skor += 50;
      else if (/search|cari|query/.test(ph)) skor += 20;
      kandidat.push({ el: el, skor: skor, jarak: jarakKe(anchor, el) });
    }
    if (!kandidat.length) {
      if (hindari) return cariInput();
      log("cariInput: tidak ada kandidat kolom input yang terlihat.");
      return null;
    }
    kandidat.sort(function (a, b) {
      if (b.skor !== a.skor) return b.skor - a.skor;
      return a.jarak - b.jarak;
    });
    log("cariInput: " + kandidat.length + " kandidat → " + kandidat.slice(0, 5).map(function (k) {
      return (k.el.placeholder || k.el.name || k.el.id || k.el.tagName) +
        "[skor " + k.skor + ", jarak " + Math.round(k.jarak) + "]";
    }).join(" | "));
    return kandidat[0].el;
  }

  function isiNomor(nomor) {
    var nilai = String(nomor);
    var mau = nilai.replace(/\D/g, "");
    var el = cariInput();
    if (!el) return false;
    for (var coba = 1; coba <= 3; coba++) {
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      try { el.focus(); } catch (e) {}
      try { el.click(); } catch (e) {}
      var terpasang = false;
      // setRangeText mengubah nilai seolah diketik manusia, jadi kerangka kerja Gladius
      // benar-benar mencatatnya. Kalau tidak didukung, jatuh ke setter nilai biasa.
      try {
        if (typeof el.setRangeText === "function" && typeof el.setSelectionRange === "function") {
          el.setSelectionRange(0, el.value.length);
          el.setRangeText(nilai, 0, el.value.length, "end");
          terpasang = true;
        }
      } catch (e) { terpasang = false; }
      if (!terpasang) {
        try {
          var proto = (el.tagName === "TEXTAREA") ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          if (setter) setter.call(el, nilai);
          else el.value = nilai;
        } catch (e) { el.value = nilai; }
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
      // Verifikasi sungguhan: versi lama selalu return true walau kolomnya tetap kosong,
      // sehingga tombol Cek ditekan dengan input kosong dan hasilnya selalu gagal.
      var isi = String(el.value || "").replace(/\D/g, "");
      if (isi === mau && isi.length > 0) return true;
      log("isiNomor: percobaan " + coba + "/3 gagal, kolom berisi '" + el.value + "'.");
      // Kemungkinan salah kolom → pilih kandidat lain di percobaan berikutnya.
      el = cariInput(el) || el;
    }
    return false;
  }

  function pilihDomain(domain) {
    domain = String(domain).toLowerCase().trim();
    var pat = /\./;
    var sel = document.querySelectorAll("select");
    for (var i = 0; i < sel.length; i++) {
      var s = sel[i];
      var ada = false;
      for (var j = 0; j < s.options.length; j++) {
        if (pat.test((s.options[j].text || "") + " " + (s.options[j].value || ""))) { ada = true; break; }
      }
      if (!ada) continue;
      for (var k = 0; k < s.options.length; k++) {
        var o = s.options[k];
        var teks = ((o.text || "") + " " + (o.value || "")).replace(/\s+/g, " ").trim().toLowerCase();
        if (teks.indexOf(domain) >= 0) {
          s.value = o.value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          s.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      }
    }
    if (klikTeks(domain, false)) return true;
    return false;
  }

  function bacaDomainTerpilih() {
    var pat = /\./;
    var sel = document.querySelectorAll("select");
    for (var i = 0; i < sel.length; i++) {
      var s = sel[i];
      var ada = false;
      for (var j = 0; j < s.options.length; j++) {
        if (pat.test((s.options[j].text || "") + " " + (s.options[j].value || ""))) { ada = true; break; }
      }
      if (!ada) continue;
      var so = s[s.selectedIndex];
      return so ? ((so.text || "") + " " + (so.value || "")).replace(/\s+/g, " ").trim() : "";
    }
    return "";
  }

  // Baca nilai paket HANYA dari <tr> yang labelnya persis kolom paket, dan hanya dari sel
  // tepat di sebelah kanannya. Versi lama menyisir div/span/li tanpa batas sehingga teks
  // notifikasi ikut tertangkap -> paket_ok=true palsu -> LRU dikala halaman kosong.
  function bacaPaket() {
    if (dialogMenyatakanKosong()) return "";
    var pat = new RegExp(
      "^\\s*(?:" +
      TEKS_KOLOM_PAKET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|" +
      TEKS_KOLOM_PAKET_ALT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      ")\\s*[:=-]?\\s*$",
      "i"
    );
    var rows = document.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var sel = rows[i].querySelectorAll("td,th");
      for (var j = 0; j + 1 < sel.length; j++) {
        var label = normTeks(sel[j].innerText || sel[j].textContent);
        if (!pat.test(label)) continue;
        var nilai = normTeks(sel[j + 1].innerText || sel[j + 1].textContent);
        if (!nilai || terlihatNotifikasi(nilai)) return "";
        if (nilaiKosong(nilai)) continue;
        return nilai;
      }
    }
    return "";
  }

  function nilaiKosong(nilai) {
    nilai = normTeks(nilai).toLowerCase();
    return NILAI_PAKET_KOSONG.indexOf(nilai) >= 0;
  }

  function rectAbs(el) {
    var r = el.getBoundingClientRect();
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
    };
  }

  function gabungRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    };
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Area "hasil ukur" untuk screenshot: tabel hasil Embassy ("paket radius/pcrf")
  // + panel "Last Five Usage", ditambah sidebar/logo Gladius di kiri atas.
  function cariKotakHasil() {
    var kw = TEKS_KOLOM_PAKET, alt = TEKS_KOLOM_PAKET_ALT;
    var pat = new RegExp("(?:" + esc(kw) + "|" + esc(alt) + ")", "i");
    var patLfu = new RegExp(esc(TEKS_TOMBOL_LFU), "i");
    var box = null;
    var semua = document.querySelectorAll("td,th,tr,div,span,label,table");
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      var t = normTeks(el.innerText || el.textContent || "");
      if (!t || t.length > 4000) continue;
      if (!t.match(pat) && !t.match(patLfu)) continue;
      var r = rectAbs(el);
      if (r.right <= r.left || r.bottom <= r.top) continue;
      if (r.bottom - r.top > 20000) continue;
      box = gabungRect(box, r);
    }
    if (!box) return null;
    var doc = document.documentElement;
    var lebar = Math.max(document.body.scrollWidth, doc.scrollWidth, window.innerWidth);
    var tinggi = Math.max(document.body.scrollHeight, doc.scrollHeight, window.innerHeight);
    box.left = 0; // selalu sertakan sidebar/logo kiri
    box.top = Math.max(0, Math.floor(box.top - SS_CROP_PAD));
    box.right = Math.min(lebar, Math.ceil(box.right + SS_CROP_PAD));
    box.bottom = Math.min(tinggi, Math.ceil(box.bottom + SS_CROP_PAD));
    return box;
  }

  // Tunggu sampai Gladius benar-benar selesai render, bukan sekadar "panjang teks tidak
  // berubah ~1 detik" (versi lama resolve terlalu awal saat XHR masih berjalan).
  // Syarat: tidak ada dialog membekukan halaman, tidak ada spinner/overlay loading, dan
  // isi area hasil berubah dari snapshot sebelum aksi.
  function adaSpinner() {
    var sel = ".fa-spinner,.spinner,.loading,.loader,[class*='spinner'],[class*='loader'],[aria-busy='true']";
    var els;
    try { els = document.querySelectorAll(sel); } catch (e) { return false; }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.offsetParent === null) continue;
      var t = normTeks(el.innerText || el.textContent);
      // Ignore decorative elements with no own text.
      if (t && t.length > 80) continue;
      return true;
    }
    return false;
  }

  function sidikJari() {
    return normTeks(document.body ? (document.body.innerText || "") : "");
  }

  function tungguTenang(kapurMs, sebelum) {
    return new Promise(function (resolve) {
      var akhir = Date.now() + (kapurMs || 0);
      var basis = sebelum == null ? null : normTeks(sebelum);
      var stabil = 0;
      (function cek() {
        var berubah = basis === null ? true : sidikJari() !== basis;
        var bebas = dialogTua(1500) && !adaSpinner() && berubah;
        if (bebas) {
          stabil++;
          if (stabil >= 2) { resolve(true); return; }
        } else {
          stabil = 0;
        }
        if (Date.now() >= akhir) { resolve(bebas || stabil >= 1); return; }
        setTimeout(cek, 400);
      })();
    });
  }

  function teksEl(el) {
    return String((el && (el.innerText || el.textContent || el.value)) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pathSekarang() {
    return location.pathname.replace(/\/+$/, "") || "/";
  }

  function pathTarget(jenis) {
    return jenis === "password"
      ? "/internetnumberr/passwordchecknew"
      : "/radonline/newradonline";
  }

  function targetURL(jenis) {
    return jenis === "password" ? URL_PASSWORD : URL_EMBASSY;
  }

  function diHalamanTarget(jenis) {
    return pathSekarang() === pathTarget(jenis);
  }

  // Navigasi langsung ke URL target. Klik menu sidebar DIHAPUS karena homepage Gladius
  // tidak punya sidebar (hanya kartu dashboard), sehingga tungguMenu selalu kehabisan
  // 3 dtk + 5 dtk lalu mengklik elemen kartu yang salah. URL kedua halaman sudah
  // terverifikasi (lihat LOG-MAGANG/2026-09-28.md bagian 2.2).
  async function bukaHalaman(jenis) {
    if (diHalamanTarget(jenis)) return "ready";
    setStatus("🔎 Membuka halaman " + (jenis === "password" ? "Password Check" : "Embassy") + " ...");
    try { location.assign(targetURL(jenis)); } catch (e) {}
    return "navigating";
  }

  async function tungguFormTugas(jenis) {
    var mulai = Date.now();
    var maks = jenis === "password" ? WAIT_PASSWORD_MS : WAIT_HASIL_MS;
    while (Date.now() - mulai < maks) {
      // Jangan anggap form "siap" selagi dialog native masih membekukan halaman:
      // elemen bisa terbaca ada, tapi kliknya tidak akan pernah dieksekusi.
      if (dialogTua(1000)) {
        var input = cariInput();
        var tombol = jenis === "password"
          ? (cariTeks(TEKS_TOMBOL_PASSWORD, true) || cariTeks("Cek", true))
          : cariTeks(TEKS_TOMBOL_CEK, true);
        if (input && tombol) return true;
      }
      await wait(500);
    }
    return false;
  }

  // ===================== PROSES 1 NOMOR (alur embassy.py, toleran reload) =====================

  // Domain berikut yang BELUM dicoba (menghindari domain sama berulang saat resume).
  function domainBerikutnya(st) {
    var dicoba = {};
    (st.coba || []).forEach(function (d) { dicoba[d.toLowerCase()] = true; });
    var terpilih = (bacaDomainTerpilih() || "").toLowerCase();
    if (terpilih) {
      DAFTAR_DOMAIN.forEach(function (d) {
        if (terpilih.indexOf(d) >= 0) dicoba[d.toLowerCase()] = true;
      });
    }
    for (var i = 0; i < DAFTAR_DOMAIN.length; i++) {
      var d = DAFTAR_DOMAIN[i];
      if (!dicoba[d.toLowerCase()]) return d;
    }
    return null;
  }

  // Poll sel paket sampai terisi atau timeout (anti "fake empty": halaman hasil
  // Gladius kadang masih render saat resume, baca 1× bisa kelewat → LFU terlewat).
  function tungguHasilPaket(maxMs) {
    maxMs = maxMs || 30000;
    return new Promise(function (resolve) {
      var mulai = Date.now();
      (function poll() {
        var v = bacaPaket();
        // Stops as soon as a real value is present, or when the page explicitly
        // says the data does not exist (no point in waiting out the full timeout).
        if (!nilaiKosong(v) || dialogMenyatakanKosong() || Date.now() - mulai >= maxMs) {
          resolve(v);
          return;
        }
        setTimeout(poll, 500);
      })();
    });
  }

  // Setelah tombol "Cek" ditekan (inline ATAU resume pasca-reload): baca hasilnya.
  async function lanjutDariCek(st) {
    var paket = await tungguHasilPaket(30000);
    if (!nilaiKosong(paket)) {
      st.paket_ok = true;
      st.domain = bacaDomainTerpilih() || null;
      return lanjutKeLfu(st);
    }

    var domain = domainBerikutnya(st);
    if (!domain) {
      // SEMUA domain kosong → tetap kirim screenshot (tanpa Last Five Usage).
      st.paket_ok = false;
      return lanjutKeScreenshot(st);
    }

    st.coba.push(domain);
    st.attempts++;
    st.step = "cek";
    simpanState(st);
    setStatus("⚙️ " + st.nomor + " · coba domain " + domain);
    if (pilihDomain(domain) && klikTeks(TEKS_TOMBOL_CEK, true)) {
      // Klik Cek memicu reload halaman. Ini reload milik kita, catat terpisah.
      st.reload_ours = (st.reload_ours || 0) + 1;
      simpanState(st);
      await tungguTenang(WAIT_HASIL_MS, sidikJari());
      // Bila klik tadi memicu reload, bagian ini mati → resume yang meneruskan.
      return lanjutDariCek(bacaState() || st);
    }
    return lanjutDariCek(st);
  }

  function cariElemenStatusPassword() {
    var labels = ["status password", "password status", "status pelanggan", "status"];
    var nodes = document.querySelectorAll("td, th, label, span, div");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.offsetParent === null) continue;
      var t = teksEl(el).toLowerCase();
      if (!t || t.length > 300) continue;
      for (var j = 0; j < labels.length; j++) {
        if (t === labels[j] || t.indexOf(labels[j] + " ") >= 0 || t.indexOf(labels[j] + ":") >= 0) {
          return el;
        }
      }
    }
    return null;
  }

  // Status tidak terbaca TIDAK lagi ditulis sebagai kalimat "tidak ditemukan" karena
  // ikut masuk ke caption Telegram dan menyesatkan (data sebenarnya ada, hanya belum
  // ter-render). Sekarang dikembalikan "" + flag terpisah.
  var STATUS_PW_TERBACA = false;

  function bacaStatusPassword() {
    STATUS_PW_TERBACA = false;
    var labels = ["status password", "password status", "status pelanggan", "status"];
    var tables = document.querySelectorAll("table");
    for (var ti = 0; ti < tables.length; ti++) {
      var trs = tables[ti].querySelectorAll("tr");
      for (var hi = 0; hi < trs.length; hi++) {
        var headers = trs[hi].querySelectorAll("th, td");
        for (var h = 0; h < headers.length; h++) {
          var headerText = teksEl(headers[h]).toLowerCase();
          var isStatus = false;
          for (var li = 0; li < labels.length; li++) {
            if (headerText === labels[li] || headerText.indexOf(labels[li] + " ") >= 0) {
              isStatus = true;
              break;
            }
          }
          if (!isStatus) continue;
          for (var ri = hi + 1; ri < trs.length; ri++) {
            var dataCells = trs[ri].querySelectorAll("td");
            var statusValue = dataCells[h] ? teksEl(dataCells[h]) : "";
            if (statusValue && !terlihatNotifikasi(statusValue)) {
              STATUS_PW_TERBACA = true;
              return statusValue.slice(0, 200);
            }
          }
        }
      }
    }
    var el = cariElemenStatusPassword();
    if (!el) return "";
    var row = el.closest("tr");
    if (row) {
      var cells = row.querySelectorAll("td, th");
      for (var i = 0; i < cells.length; i++) {
        if (cells[i] === el && i + 1 < cells.length) {
          var value = teksEl(cells[i + 1]);
          if (value && !terlihatNotifikasi(value)) {
            STATUS_PW_TERBACA = true;
            return value.slice(0, 200);
          }
        }
      }
    }
    var sibling = el.nextElementSibling;
    if (sibling) {
      var siblingText = teksEl(sibling);
      if (siblingText && siblingText.length <= 200 && !terlihatNotifikasi(siblingText)) {
        STATUS_PW_TERBACA = true;
        return siblingText;
      }
    }
    var text = teksEl(el);
    var match = text.match(/status(?:\s+(?:password|pelanggan))?\s*[:\-]\s*(.+)$/i);
    if (match && match[1]) {
      var mv = match[1].trim();
      if (!terlihatNotifikasi(mv)) {
        STATUS_PW_TERBACA = true;
        return mv.slice(0, 200);
      }
    }
    return "";
  }

  // Poll status password sampai muncul. Tabel status sering menyusul beberapa detik
  // setelah render utama; versi lama hanya memberi satu kesempatan 2 dtk lalu menyerah
  // dan caption berbunyi "Status belum terbaca saat diambil. Lihat fotonya."
  async function tungguStatusPassword(maxMs) {
    maxMs = maxMs || 30000;
    var mulai = Date.now();
    while (Date.now() - mulai < maxMs) {
      var s = bacaStatusPassword();
      if (s) return s;
      if (dialogMenyatakanKosong()) return "";
      await wait(500);
    }
    return bacaStatusPassword();
  }

  function maskPasswordValues() {
    var changes = [];
    function hide(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.__getembassyMasked) return;
      el.__getembassyMasked = true;
      changes.push({ el: el, filter: el.style.filter });
      el.style.filter = "blur(7px)";
    }

    var passwordInputs = document.querySelectorAll("input[type='password']");
    for (var i = 0; i < passwordInputs.length; i++) hide(passwordInputs[i]);

    var labelled = document.querySelectorAll("[aria-label], [name], [id]");
    for (var j = 0; j < labelled.length; j++) {
      var attrs = [
        labelled[j].getAttribute("aria-label") || "",
        labelled[j].getAttribute("name") || "",
        labelled[j].getAttribute("id") || "",
      ].join(" ");
      if (/password/i.test(attrs)) hide(labelled[j]);
    }

    var cells = document.querySelectorAll("td, th");
    for (var k = 0; k < cells.length; k++) {
      var cell = cells[k];
      var text = teksEl(cell);
      if (!/^password\b/i.test(text)) continue;
      if (/password\s*[:\-]/i.test(text)) hide(cell);
      if (cell.tagName.toLowerCase() !== "th") {
        var next = cell.nextElementSibling;
        if (next) hide(next);
      }
      var row = cell.closest("tr");
      if (!row) continue;
      var table = row.closest("table");
      if (!table) continue;
      var rowCells = row.querySelectorAll("th, td");
      var column = Array.prototype.indexOf.call(rowCells, cell);
      if (column < 0) continue;
      var rows = table.querySelectorAll("tr");
      for (var r = 0; r < rows.length; r++) {
        var otherCells = rows[r].querySelectorAll("th, td");
        if (otherCells[column]) hide(otherCells[column]);
      }
    }

    return function restore() {
      for (var n = 0; n < changes.length; n++) {
        changes[n].el.style.filter = changes[n].filter;
        delete changes[n].el.__getembassyMasked;
      }
    };
  }

  async function lanjutPassword(st) {
    var basis = sidikJari();
    if (st.step === "password_cek") {
      setStatus("⚙️ Password check " + st.nomor + " ...");
      if (!isiNomor(st.nomor)) throw new Error("Gagal mengisi Nomor Internet (kolom tidak ditemukan atau nilai tidak terverifikasi).");
      st.step = "password_hasil";
      st.password_clicked = true;
      simpanState(st);
      if (!klikTeks(TEKS_TOMBOL_PASSWORD, true)) {
        throw new Error("Tombol '" + TEKS_TOMBOL_PASSWORD + "' tidak ditemukan.");
      }
      await tungguTenang(WAIT_PASSWORD_MS, basis);
    } else {
      await tungguTenang(WAIT_PASSWORD_MS, basis);
    }
    // Tabel status sering menyusul beberapa detik setelah render utama. Beri waktu
    // sampai 30 dtk (poll 500 ms) supaya tidak terbaca kosong lalu langsung difoto.
    var status = await tungguStatusPassword(30000);
    st.status = status;
    st.status_terbaca = STATUS_PW_TERBACA;
    st.step = "password_screenshot";
    simpanState(st);
    return lanjutKeScreenshot(st);
  }

  // Konfirmasi panel Last Five Usage benar-benar terbuka. Versi lama menulis
  // lfu_ok=true hanya karena tombolnya diklik, padahal panelnya tidak pernah muncul —
  // itu sebabnya caption bilang LFU gagal padahal tidak, atau sebaliknya.
  function lfuSudahTerbuka() {
    if (dialogMenyatakanKosong()) return false;
    var pat = new RegExp(TEKS_TOMBOL_LFU.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    var semua = document.querySelectorAll("table,div,section,ul,ol");
    var bukti = 0;
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      if (el.offsetParent === null) continue;
      var t = normTeks(el.innerText || el.textContent);
      if (!t || t.length > 4000) continue;
      if (!pat.test(t)) continue;
      // Panel LFU dianggap terbuka bila ada isi tabel/baris di dalamnya yang bukan
      // sekadar tombol dan bukan teks "tidak ditemukan".
      var isi = el.querySelectorAll("table tr, ul li, ol li");
      for (var j = 0; j < isi.length; j++) {
        var baris = normTeks(isi[j].innerText || isi[j].textContent);
        if (!baris || baris.length > 300) continue;
        if (pat.test(baris) && baris.length < 40) continue; // ini tombolnya, bukan isi
        if (terlihatNotifikasi(baris)) continue;
        bukti++;
      }
    }
    return bukti > 0;
  }

  // Poll sampai tabel Last Five Usage benar-benar ter-render. Setelah tombol LFU diklik,
  // Gladius reload dan tabelnya sudah tersedia di halaman hasil — jadi verifikasi ini
  // cukup menunggu render, tanpa perlu klik ulang.
  async function tungguLfuTerbuka(maxMs) {
    maxMs = maxMs || WAIT_LFU_MS;
    var mulai = Date.now();
    while (Date.now() - mulai < maxMs) {
      if (lfuSudahTerbuka()) return true;
      if (dialogMenyatakanKosong()) return false;
      await wait(500);
    }
    return lfuSudahTerbuka();
  }

  // Paket sudah berisi → klik "Last Five Usage".
  async function lanjutKeLfu(st) {
    st.step = "lfu";
    st.lfu_attempts = st.lfu_attempts || 0;
    simpanState(st);
    setStatus("⚙️ " + st.nomor + " · Last Five Usage...");

    // Klik HANYA SEKALI. Gladius me-reload halaman saat tombol LFU diklik, dan tabel LFU
    // sudah ter-render di halaman hasil reload itu. Versi lama mengklik ULANG tiap resume
    // pasca-reload → klik memicu reload, reload memicu klik lagi → loop tanpa henti sampai
    // MAX_ATTEMPTS habis, dengan pesan "Proses terulang karena halaman reload berulang".
    if (!st.lfu_clicked && st.lfu_attempts < 2) {
      if (!klikTeks(TEKS_TOMBOL_LFU, true)) {
        // Tombol tidak ketemu → jangan diam-diam: tandai lfu_ok=false + warning,
        // screenshot tetap dikirim (caption nanti memuat catatan LFU gagal).
        setStatus("⚠️ " + st.nomor + " · tombol Last Five Usage tidak ditemukan");
        log("LFU tidak ditemukan untuk " + st.nomor + " (screenshot tetap dikirim).");
        st.lfu_ok = false;
        simpanState(st);
        return lanjutKeScreenshot(bacaState() || st);
      }
      st.lfu_clicked = true;
      st.lfu_attempts++;
      // Hanya reload yang DIAKIBATKAN klik kita yang dihitung, supaya auto-refresh
      // Gladius atau reload bawaan halaman tidak ikut menghabiskan anggaran.
      st.reload_ours = (st.reload_ours || 0) + 1;
      simpanState(st);
      await tungguTenang(WAIT_LFU_MS, sidikJari());
      // Bila klik memicu reload → mati di sini; resume 'lfu' TIDAK mengklik ulang,
      // hanya menunggu tabel yang sudah ada.
    } else {
      log("LFU resume: tabel sudah ada di halaman, tidak mengklik ulang.");
    }

    st.lfu_ok = await tungguLfuTerbuka(WAIT_LFU_MS);
    simpanState(st);
    return lanjutKeScreenshot(bacaState() || st);
  }

  async function lanjutKeScreenshot(st) {
    // Baca ulang state tepat sebelum foto. Gladius kerap merender beberapa detik
    // setelah langkah sebelumnya, jadi caption dan foto harus berasal dari bacaan
    // yang sama — inilah penyebab lama caption "tidak ditemukan" padahal fotonya berisi data.
    if (st.jenis === "embassy" && !st.paket_ok) {
      var p = bacaPaket();
      if (!nilaiKosong(p)) {
        st.paket_ok = true;
        st.domain = bacaDomainTerpilih() || st.domain || null;
      }
    }

    if (st.jenis === "password") {
      // Baca ulang status tepat sebelum foto, sama seperti paket Embassy. Dulu status
      // dibaca sekali di lanjutPassword() lalu tidak pernah diperbarui, sehingga caption
      // berbunyi "Status belum terbaca" padahal tabelnya sudah ada saat difoto.
      var sp = await tungguStatusPassword(5000);
      if (sp) {
        st.status = sp;
        st.status_terbaca = STATUS_PW_TERBACA;
      }
    }

    setStatus("📸 Ambil screenshot " + st.nomor + " ...");
    var foto = await ambilSS(st.jenis);
    if (!foto) throw new Error("Screenshot kosong.");
    var payload = {
      id: st.id,
      chat_id: st.chat_id,
      message_id: st.message_id,
      nomor: st.nomor,
      jenis: st.jenis || "embassy",
      status: st.status || "",
      status_terbaca: st.status_terbaca !== false,
      dialog: DIALOG_TERAKHIR ? DIALOG_TERAKHIR.pesan.slice(0, 200) : "",
      foto: foto,
      paket_ok: !!st.paket_ok,
      lfu_ok: !!st.lfu_ok,
      domain_terpakai: st.domain || null,
      waktu: fmtWaktu(),
    };
    setStatus("📤 Kirim hasil " + st.nomor + " ...");
    var resp = await kirimHasil(payload);
    hapusState();
    tandaiHandled(st.id);
    if (resp && resp.ok && resp.sent) {
      setStatus("✅ Selesai " + st.nomor);
      log("Hasil " + st.nomor + " terkirim.");
    } else {
      setStatus("🔴 Gagal kirim foto " + st.nomor);
      log("Gagal kirim ke server bot: " + JSON.stringify(resp));
    }
  }

  // Dipanggil saat script (baru) terbangun setelah reload — lanjut dari checkpoint.
  async function cobaResumeSetelahReload() {
    var st = bacaState();
    if (!st) return false;
    if (sudahHandled(st.id)) { hapusState(); return false; }
    st.jenis = st.jenis === "password" ? "password" : "embassy";
    st.resume = (st.resume || 0) + 1;
    simpanState(st);
    // Tiga batas independen: percobaan domain, reload yang DIAKIBATKAN klik kita, dan
    // jumlah kebangunan script (jaring pengaman untuk auto-refresh tak terduga Gladius).
    // Dulu hanya ada satu batas (st.resume >= MAX_ATTEMPTS) sehingga reload normal pun
    // ikut menghabiskan anggaran dan tugas gagal padahal masih sehat.
    if (
      st.attempts >= MAX_ATTEMPTS ||
      (st.reload_ours || 0) > MAX_ATTEMPTS ||
      st.resume > MAX_ATTEMPTS
    ) {
      setStatus("🔴 Gagal (reload berulang) " + st.nomor);
      log("Task " + st.id + " menyerah: attempts=" + st.attempts +
        ", reload_ours=" + (st.reload_ours || 0) + ", resume=" + st.resume + ".");
      try {
        await laporGagal({
          id: st.id, status: "gagal",
          pesan: "Proses berhenti setelah halaman Gladius reload berulang kali. Silakan cek manual atau login ulang.",
          chat_id: st.chat_id, message_id: st.message_id,
          nomor: st.nomor, jenis: st.jenis,
        });
      } catch (e) {}
      hapusState();
      return true;
    }
    idAktif = st.id;
    lagiProses = true;
    setStatus("↩️ Lanjut " + st.nomor + " (" + st.step + ")...");
    try {
      await tungguTenang(6000);
      var navigasi = await bukaHalaman(st.jenis);
      if (navigasi !== "ready") {
        // location.assign selalu meninggalkan konteks ini (halaman reload). Kalau kita
        // sampai di sini BERULANG tanpa pernah mendarat di halaman target, berarti sesi
        // Gladius sudah habis dan halaman memantul ke login. Hitung lalu berhenti --
        // jangan biarkan tak terbatas, dan jangan keluar diam-diam tanpa jejak.
        st.nav = (st.nav || 0) + 1;
        simpanState(st);
        if (st.nav >= 3) {
          setStatus("🔴 Gagal buka halaman " + st.nomor);
          log("Navigasi gagal " + st.nav + "x untuk " + st.nomor + " (jenis " + st.jenis + ").");
          try {
            await laporGagal({
              id: st.id, status: "gagal",
              pesan: "Tidak bisa membuka halaman " +
                (st.jenis === "password" ? "Password Check" : "Embassy") +
                " (sesi Gladius mungkin habis). Silakan login ulang.",
              chat_id: st.chat_id, message_id: st.message_id,
              nomor: st.nomor, jenis: st.jenis,
            });
          } catch (e) {}
          hapusState();
        }
        return true;
      }
      st.nav = 0;
      simpanState(st);
      if (st.jenis === "password" && st.step === "password_cek") {
        if (!await tungguFormTugas(st.jenis)) {
          throw new Error("Form Password Check belum siap.");
        }
      } else if (st.jenis === "embassy" && st.step === "cek") {
        if (!await tungguFormTugas(st.jenis)) {
          throw new Error("Form Embassy belum siap.");
        }
      }
      if (st.jenis === "password") {
        await lanjutPassword(st);
      } else if (st.step === "lfu") {
        await lanjutKeLfu(st);
      } else {
        await lanjutDariCek(st);
      }
    } catch (err) {
      setStatus("🔴 Gagal lanjut " + st.nomor);
      log("Resume gagal: " + err);
      try {
        await laporGagal({
          id: st.id, status: "gagal", pesan: String(err).slice(0, 200),
          chat_id: st.chat_id, message_id: st.message_id,
          nomor: st.nomor, jenis: st.jenis,
        });
      } catch (e) {}
      hapusState();
    } finally {
      lagiProses = false;
      idAktif = null;
      updateTampilanAuto();
    }
    return true;
  }

  // html2canvas dimuat malas (lazy), bukan lewat @require, supaya halaman Gladius tidak
  // menunggu unduhan pihak ketiga setiap kali dibuka. Hanya diunduh saat screenshot
  // pertama benar-benar dibutuhkan.
  var _h2cSedang = null;
  function muatHtml2canvas() {
    if (typeof window.html2canvas !== "undefined") return Promise.resolve(window.html2canvas);
    if (_h2cSedang) return _h2cSedang;
    _h2cSedang = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://html2canvas.hertzen.com/dist/html2canvas.min.js";
      s.async = true;
      var batal = setTimeout(function () {
        reject(new Error("html2canvas timeout (>40 dtk). Cek koneksi internet."));
      }, 40000);
      s.onload = function () { clearTimeout(batal); resolve(window.html2canvas); };
      s.onerror = function () {
        clearTimeout(batal);
        reject(new Error("html2canvas gagal dimuat (cek koneksi internet)."));
      };
      (document.head || document.documentElement).appendChild(s);
    });
    // Kalau gagal, izinkan percobaan ulang di screenshot berikutnya.
    _h2cSedang.catch(function () { _h2cSedang = null; });
    return _h2cSedang;
  }

  async function ambilSS(jenis) {
    await muatHtml2canvas();
    var restore = jenis === "password" ? maskPasswordValues() : function () {};
    var doc = document.documentElement;
    var w = Math.max(document.body.scrollWidth, doc.scrollWidth, window.innerWidth);
    var h = Math.max(document.body.scrollHeight, doc.scrollHeight, window.innerHeight);
    var box = null;
    var mode = String(SS_CROP || "auto").toLowerCase();
    if (mode === "auto") {
      if (SS_CROP_OVERRIDE) {
        box = {
          left: Math.max(0, Number(SS_CROP_OVERRIDE.left) || 0),
          top: Math.max(0, Number(SS_CROP_OVERRIDE.top) || 0),
          right: Math.min(w, Number(SS_CROP_OVERRIDE.right) || w),
          bottom: Math.min(h, Number(SS_CROP_OVERRIDE.bottom) || h),
        };
      } else {
        box = cariKotakHasil();
      }
      if (box) {
        box.left = Math.max(0, Math.floor(box.left));
        box.top = Math.max(0, Math.floor(box.top));
        box.right = Math.min(w, Math.ceil(box.right));
        box.bottom = Math.min(h, Math.ceil(box.bottom));
      }
    }
    if (!box) box = { left: 0, top: 0, right: w, bottom: h };
    // Dialog native membekukan halaman; html2canvas butuh event loop bebas supaya tidak
    // menghasilkan canvas setengah jadi (halaman tampak utuh tapi banyak area putih).
    // Versi lama memanggil ulang dirinya sendiri dari dalam executor Promise -> hasilnya
    // dibuang dan Promise luar tidak pernah selesai (menggantung). Sekarang cukup loop.
    var tungguDialog = 0;
    while (!dialogTua(500) && tungguDialog < 30) {
      await wait(500);
      tungguDialog++;
    }
    try { window.scrollTo(0, box.top); } catch (e) {}
    var dataUrl;
    try {
      dataUrl = await new Promise(function (resolve, reject) {
        window.html2canvas(document.body, {
          useCORS: true,
          allowTaint: false,
          scale: Math.min(window.devicePixelRatio || 1, SS_SCALE),
          x: box.left,
          y: box.top,
          width: Math.max(1, box.right - box.left),
          height: Math.max(1, box.bottom - box.top),
          windowWidth: w,
          windowHeight: h,
          backgroundColor: "#ffffff",
          logging: false,
        }).then(function (canvas) {
          resolve(canvas.toDataURL("image/png"));
        }).catch(reject);
      });
    } finally {
      restore();
    }
    return dataUrl.indexOf(",") >= 0 ? dataUrl.split(",")[1] : "";
  }

  // ===================== KOMUNIKASI DENGAN SERVER BOT =====================

  function reqGM(opt) {
    reqAktif++;
    return new Promise(function (resolve) {
      function selesai(body, err) {
        reqAktif = Math.max(0, reqAktif - 1);
        resolve({ body: body, err: err });
      }
      if (typeof GM_xmlhttpRequest !== "undefined") {
        GM_xmlhttpRequest({
          method: opt.method || "GET",
          url: opt.url,
          data: opt.data,
          headers: opt.headers || {},
          timeout: opt.timeout || 25000,
          onload: function (r) { selesai(r.responseText); },
          onerror: function () { selesai("", "onerror"); },
          ontimeout: function () { selesai("", "timeout"); },
        });
      } else {
        // fetch tidak punya timeout sendiri; tanpa pembatalan, request yang menggantung
        // membuat reqAktif tersangkut > 0 selamanya dan memblokir reload penjaga.
        var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var init = { method: opt.method || "GET" };
        if (ctl) init.signal = ctl.signal;
        if (opt.data) { init.body = opt.data; init.headers = opt.headers || {}; }
        var batal = setTimeout(function () { if (ctl) ctl.abort(); }, opt.timeout || 25000);
        fetch(opt.url, init)
          .then(function (r) { return r.text(); })
          .then(function (txt) { clearTimeout(batal); selesai(txt); })
          .catch(function (e) { clearTimeout(batal); selesai("", String(e)); });
      }
    });
  }

  async function ambilAntrian() {
    var url = RAILWAY_URL + "/antrian?secret=" + encodeURIComponent(AGENT_SECRET);
    var res = await reqGM({ url: url, timeout: 20000 });
    if (res.err) return [];
    try {
      var j = JSON.parse(res.body);
      return (j && j.items) || [];
    } catch (e) {
      return [];
    }
  }

  // Timeout dibuat jauh di atas durasi unggah bot (bot.py pakai requests timeout=120).
  // Nilai lama 30s pasti kalah untuk foto besar -> ConnectionAbortedError -> badge
  // "Gagal kirim" padahal foto sudah sampai ke Telegram.
  var KIRIM_TIMEOUT_MS = 180000;

  async function kirimHasil(payload) {
    sentuhAktivitas();
    var url = RAILWAY_URL + "/kirim?secret=" + encodeURIComponent(AGENT_SECRET);
    var res = await reqGM({
      method: "POST",
      url: url,
      data: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      timeout: KIRIM_TIMEOUT_MS,
    });
    try { return JSON.parse(res.body); }
    catch (e) { return { ok: false }; }
  }

  async function laporGagal(payload) {
    sentuhAktivitas();
    var url = RAILWAY_URL + "/selesai?secret=" + encodeURIComponent(AGENT_SECRET);
    try {
      await reqGM({
        method: "POST",
        url: url,
        data: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      });
    } catch (e) { /* abaikan */ }
  }

  // ===================== UI (badge status + tombol Auto) =====================

  var autoAktif = true;
  var lagiProses = false;
  var idAktif = null;
  // Aktivitas terakhir yang dihitung untuk penjaga sesi. Poll /antrian SENGAJA tidak
  // menyentuhnya — itu detak jantung, bukan aktivitas PIC.
  var terakhirAktivitas = Date.now();
  // Jumlah request HTTP ke server bot yang sedang berjalan.
  var reqAktif = 0;
  var statusEl = null, toggleBtn = null;

  // Tandai bahwa PIC (atau proses) baru saja aktif, sehingga reload penjaga batal.
  function sentuhAktivitas() { terakhirAktivitas = Date.now(); }

  // Dengar interaksi nyata PIC di tab ini. Mousemove sengaja ikut: kursor yang bergerak
  // sudah cukup membuktikan PIC sedang memakai tab dan bukan sekadar meninggalkannya.
  var _pantauTerpasang = false;
  function pantauAktivitas() {
    if (_pantauTerpasang) return;
    _pantauTerpasang = true;
    var tandai = function () { terakhirAktivitas = Date.now(); };
    ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "input"].forEach(function (ev) {
      try { window.addEventListener(ev, tandai, { passive: true, capture: true }); } catch (e) {}
    });
  }
  var AUTO_KEY = "getembassy_auto_aktif";

  function setStatus(teks) {
    if (!statusEl) return;
    statusEl.textContent = teks;
  }

  function buatUI() {
    if (document.getElementById("getembassy-ui")) return;
    if (!document.body) { setTimeout(buatUI, 300); return; }

    var wadah = document.createElement("div");
    wadah.id = "getembassy-ui";
    wadah.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;flex-direction:column;" +
      "align-items:flex-end;gap:6px;font-family:Segoe UI,Arial,sans-serif;";

    statusEl = document.createElement("div");
    statusEl.id = "getembassy-status";
    statusEl.style.cssText =
      "background:rgba(30,30,30,.92);color:#fff;padding:6px 12px;border-radius:16px;" +
      "font-size:12px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap;";
    wadah.appendChild(statusEl);

    toggleBtn = document.createElement("button");
    toggleBtn.id = "getembassy-toggle";
    toggleBtn.style.cssText =
      "border:none;cursor:pointer;border-radius:16px;padding:6px 12px;font-size:12px;" +
      "font-weight:700;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);";
    toggleBtn.addEventListener("click", toggleAuto);
    wadah.appendChild(toggleBtn);

    document.body.appendChild(wadah);
    updateTampilanAuto();
  }

  function toggleAuto() {
    autoAktif = !autoAktif;
    localStorage.setItem(AUTO_KEY, autoAktif ? "1" : "0");
    updateTampilanAuto();
    if (autoAktif) { mulaiLoop(); }
  }

  function updateTampilanAuto() {
    if (!toggleBtn) return;
    toggleBtn.textContent = autoAktif ? "ON" : "OFF";
    toggleBtn.style.background = autoAktif ? "#2e7d32" : "#8a8a8a";
    if (!lagiProses) {
      setStatus(autoAktif ? "🟢 GetEmbassy: idle" : "⏸ GetEmbassy: mati");
    }
  }

  // ===================== LOOP UTAMA =====================

  async function prosesSatu(task) {
    if (!autoAktif) return false;
    if (sudahHandled(task.id)) return false;
    var stateAda = bacaState();
    if (stateAda) {
      if (sudahHandled(stateAda.id)) hapusState();
      else return false;
    }
    var jenis = task.jenis === "password" ? "password" : "embassy";
    var perluNavigasi = false;
    idAktif = task.id;
    lagiProses = true;
    log("Proses antrian " + task.id + " jenis " + jenis + " nomor " + task.nomor);
    sentuhAktivitas();
    try {
      var st = {
        id: task.id, nomor: task.nomor, jenis: jenis,
        chat_id: task.chat_id, message_id: task.message_id,
        step: jenis === "password" ? "password_cek" : "cek",
        attempts: 0, resume: 0, nav: 0, reload_ours: 0, coba: [], paket_ok: false, lfu_ok: false,
        lfu_clicked: false, lfu_attempts: 0, domain: null, status: "", password_clicked: false,
      };
      simpanState(st);

      setStatus("⚙️ Proses " + task.nomor + " ...");
      var navigasi = await bukaHalaman(jenis);
      if (navigasi !== "ready") {
        perluNavigasi = true;
        return true;
      }
      if (!await tungguFormTugas(jenis)) {
        throw new Error(
          jenis === "password"
            ? "Form Password Check belum siap."
            : "Form Embassy belum siap."
        );
      }
      if (jenis === "password") {
        await lanjutPassword(st);
      } else {
        if (!isiNomor(task.nomor)) throw new Error("Gagal mengisi Nomor Internet (kolom tidak ditemukan atau nilai tidak terverifikasi).");
        var basisCek = sidikJari();
        if (!klikTeks(TEKS_TOMBOL_CEK, true)) throw new Error("Tombol '" + TEKS_TOMBOL_CEK + "' tidak ditemukan.");
        await tungguTenang(WAIT_HASIL_MS, basisCek);
        await lanjutDariCek(bacaState() || st);
      }
    } catch (err) {
      setStatus("🔴 Gagal proses " + task.nomor);
      log("Gagal: " + err);
      try {
        await laporGagal({
          id: task.id, status: "gagal", pesan: String(err).slice(0, 200),
          chat_id: task.chat_id, message_id: task.message_id,
          nomor: task.nomor, jenis: jenis,
        });
      } catch (e) {}
      hapusState();
    } finally {
      lagiProses = false;
      idAktif = null;
      updateTampilanAuto();
    }
    return perluNavigasi;
  }

  // Reload penjaga: menembak HANYA bila tab sunyi total selama SESI_SUNYI_MS dan tidak
  // ada pekerjaan berjalan. Poll /antrian tiap 5 dtk tidak dihitung sebagai aktivitas,
  // jadi pengawasan tetap jalan tanpa membuat sesi Gladius kedaluwarsa.
  async function jagaSesi() {
    if (Date.now() - terakhirAktivitas < SESI_SUNYI_MS) return;
    if (reqAktif > 0) return;
    if (lagiProses) return;
    if (bacaState()) return;
    if (!dialogTua(2000)) return; // masih ada dialog baru -> halaman belum tenang
    log("Sesi sunyi " + Math.round((Date.now() - terakhirAktivitas) / 60000) + " menit → reload penjaga.");
    setStatus("♻️ Reload penjaga (jaga sesi Gladius)...");
    sentuhAktivitas();
    location.reload();
  }

  async function loopSiklus() {
    while (autoAktif) {
      try {
        await jagaSesi();
        var items = await ambilAntrian();
        if (items.length > 0) log("Antrian: " + items.length + " item");
        var stateAntrian = bacaState();
        if (stateAntrian && !sudahHandled(stateAntrian.id)) {
          var masihPending = false;
          for (var si = 0; si < items.length; si++) {
            if (items[si].id === stateAntrian.id) { masihPending = true; break; }
          }
          if (!masihPending) hapusState();
        }
        var stateLanjut = bacaState();
        if (
          stateLanjut &&
          !sudahHandled(stateLanjut.id) &&
          !idAktif &&
          diHalamanTarget(stateLanjut.jenis)
        ) {
          await cobaResumeSetelahReload();
          continue;
        }
        for (var i = 0; i < items.length; i++) {
          if (!autoAktif) break;
          var it = items[i];
          if (sudahHandled(it.id)) continue;
          if (idAktif && it.id === idAktif) continue;
          var stateSekarang = bacaState();
          if (stateSekarang && !sudahHandled(stateSekarang.id) && stateSekarang.id !== it.id) continue;
          var pindah = await prosesSatu(it);
          if (pindah) break;
          if (autoAktif) await tidur(1500);
        }
      } catch (err) {
        log("Loop error: " + err);
      }
      if (!autoAktif) break;
      await tidur(POLL_INTERVAL_DETIK * 1000);
    }
  }

  var loopBerjalan = false;
  function mulaiLoop() {
    if (loopBerjalan) return;
    loopBerjalan = true;
    log("Loop antrian dimulai.");
    loopSiklus().then(function () {
      loopBerjalan = false;
    }).catch(function (e) {
      loopBerjalan = false;
      log("Loop berhenti: " + e);
    });
  }

  // ===================== PASANG =====================

  async function pasang() {
    buatUI();
    pantauAktivitas();
    try {
      var tersimpan = localStorage.getItem(AUTO_KEY);
      if (tersimpan !== null) autoAktif = (tersimpan === "1");
    } catch (e) {}
    updateTampilanAuto();
    if (!autoAktif) return;

    // Cek dulu: apakah ini kebangunan setelah reload di tengah proses?
    // Jika ya, LANJUTKAN dari checkpoint (bukan mulai dari nol lagi).
    try {
      await cobaResumeSetelahReload();
    } catch (e) {
      log("Cek resume error: " + e);
    }
    mulaiLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pasang);
  } else {
    pasang();
  }
})();