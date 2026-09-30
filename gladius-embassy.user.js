// ==UserScript==
// @name         GetEmbassy Gladius - Proses Otomatis
// @namespace    http://tampermonkey.net/
// @version      1.8.2
// @description  [GetEmbassy] Auto-proses antrian /embassy dan /password dari bot lokal/server langsung di halaman Gladius: isi Nomor Internet, proses Embassy atau Password Check, ambil screenshot (html2canvas), lalu kirim base64 ke server bot. Tanpa Python/Selenium/debug port.
// @author       diana
// @match        https://gladius.telkom.co.id/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      getembassybot-production.up.railway.app
// @require      https://html2canvas.hertzen.com/dist/html2canvas.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // html2canvas lewat @require, bukan <script src> yang disuntik: jalur <script src>
  // diblokir jaringan, CDN membalas halaman blokir HTTP 200 sehingga window.html2canvas
  var H2C_ASLI = typeof window.html2canvas === "function" ? window.html2canvas : null;

  // ===================== RIWAYAT PERBAIKAN (arsip) =====================
  // Daftar bug yang sudah diperbaiki. Semuanya dulu ditulis panjang-lebar di dalam
  // masing-masing fungsi; sekarang dikumpulkan di sini supaya kode tetap ringkas.

  // ===================== NEUTRALISER DIALOG (WAJIB PALING AWAL) =====================
  // Gladius memunculkan window.alert("... data tidak dapat ditemukan ...") saat hasil
  // kosong. Dialog NATIVE membekukan SELURUH JavaScript halaman (setTimeout, promise,
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

  // WAJIB dipanggil di awal tiap task: DIALOG_TERAKHIR global, jadi tanpa reset dialog
  // "tidak ditemukan" dari task sebelumnya terbaca sebagai jawaban task berikutnya dan
  function resetDialog(nomor) {
    if (DIALOG_TERAKHIR) {
      log("Reset detector dialog" + (nomor ? " untuk task " + nomor : "") +
        " (dialog sebelumnya: '" + String(DIALOG_TERAKHIR.pesan || "").slice(0, 100) + "').");
    }
    DIALOG_TERAKHIR = null;
    DIALOG_LOG = [];
  }

  // Nilai yang terlalu panjang/berbentuk kalimat dianggap notifikasi, bukan nilai kolom.
  function terlihatNotifikasi(t) {
    t = normTeks(t);
    if (!t) return false;
    if (t.length > 60) return true;
    return POLA_TIDAK_DITEMUKAN.test(t);
  }

  // ===================== PENELUSURAN DOM LINTAS KONTEKS =====================
  // Hasil Gladius tidak selalu hidup di dokumen utama. Dua sebab yang membuat
  // pembacaan lama selalu kosong padahal tabelnya jelas-jelas terisi di layar:
  var _akarCache = null;
  var _akarCacheWaktu = 0;
  var AKAR_TTL_MS = 1500;

  function akarSemua() {
    var now = Date.now();
    if (_akarCache && _akarCache[0] === document && now - _akarCacheWaktu < AKAR_TTL_MS) return _akarCache;
    var hasil = [document];
    var antre = [document];
    var dilihat = 0;
    while (antre.length && dilihat < 40) {
      var dok = antre.shift();
      dilihat++;
      var frames = [];
      try { frames = dok.querySelectorAll("iframe,frame"); } catch (e) { continue; }
      for (var i = 0; i < frames.length; i++) {
        var dalam = null;
        try { dalam = frames[i].contentDocument; } catch (e2) { dalam = null; }
        if (!dalam || hasil.indexOf(dalam) >= 0) continue; // cross-origin dilewati
        hasil.push(dalam);
        antre.push(dalam);
        // Dialog NATIVE di dalam iframe juga membekukan halaman, jadi patch juga
        // window.alert di sana. Kalau tidak, hasil di iframe bisa menggantung
        try {
          var win = frames[i].contentWindow;
          if (win && typeof win.alert === "function" && !win.alert.__getEmbassy) {
            var patched = function (pesan) {
              catatDialog(pesan, "alert-iframe");
              try { console.log("[GetEmbassy] alert iframe dicegat:", pesan); } catch (e) {}
              return undefined; // JANGAN panggil alert asli — itu yang membekukan halaman.
            };
            patched.__getEmbassy = true;
            win.alert = patched;
          }
        } catch (e3) {}
      }
    }
    _akarCache = hasil;
    _akarCacheWaktu = now;
    return hasil;
  }

  function namaAkar(akar) {
    return akar === document ? "dokumen-utama" : "iframe";
  }

  // querySelectorAll yang menembus shadow root. Satu kali lintasan untuk selector
  // biasa; rekursif hanya kalau benar-benar ada shadow host (jarang, tapi kalau
  function qsSemua(akar, sel) {
    var out = [];
    var semua = [];
    try { semua = akar.querySelectorAll("*"); } catch (e) { return []; }
    var adaShadow = false;
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      try { if (el.matches(sel)) out.push(el); } catch (e2) {}
      if (el.shadowRoot) adaShadow = true;
    }
    if (!adaShadow) return out;
    for (var k = 0; k < semua.length; k++) {
      var sr = semua[k].shadowRoot;
      if (sr) out = out.concat(qsSemua(sr, sel));
    }
    return out;
  }

  // Bounding rect elemen dalam koordinat HALAMAN UTAMA. Kalau elemennya ada di
  // dalam iframe, getBoundingClientRect() biasanya relatif ke viewport iframe, jadi
  function rectDiHalaman(el) {
    var r = el.getBoundingClientRect();
    var kiri = r.left, atas = r.top, kanan = r.right, bawah = r.bottom;
    var d = el.ownerDocument;
    var w = d && d.defaultView;
    var sx = (w && (w.pageXOffset || 0)) || 0;
    var sy = (w && (w.pageYOffset || 0)) || 0;
    kiri += sx; atas += sy; kanan += sx; bawah += sy;
    var pengaman = 0;
    while (w && w.frameElement && pengaman < 10) {
      var fe = w.frameElement;
      var fr = fe.getBoundingClientRect();
      var dw = fe.ownerDocument && fe.ownerDocument.defaultView;
      var fx = (dw && (dw.pageXOffset || 0)) || 0;
      var fy = (dw && (dw.pageYOffset || 0)) || 0;
      kiri += fr.left + fx; atas += fr.top + fy;
      kanan += fr.left + fx; bawah += fr.top + fy;
      w = dw;
      pengaman++;
    }
    return { left: kiri, top: atas, right: kanan, bottom: bawah };
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
  var SERVER_BOT = "http://127.0.0.1:8080";
  var PORT_HTTP = 8080; // hanya untuk pesan log; tidak dipakai untuk koneksi
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
  var STATE_KEY = "getembassy_state";
  var HANDLED_KEY = "getembassy_handled";
  var MAX_ATTEMPTS = 12; // batas percobaan/reload per task
  var STATE_TTL_MS = 6 * 60 * 1000;
  var HANDLED_TTL_MS = 5 * 60 * 1000;
  // Log yang bertahan melewati reload. Dulu log hanya tulis ke console.log, padahal
  // Gladius me-reload halaman setiap kali Cek/LFU diklik — jadi tahap-tahap terpanjang
  var LOG_KEY = "getembassy_log";
  var LOG_MAX = 300;
  var LOG_CHAR_MAX = 500;
  var _gagalHttp = 0; // gagal HTTP beruntun, supaya log tidak dibanjiri tiap poll 5 dtk
  var _antrianGagal = 0;

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

  // Kunci anti duplikat: pasangan id+nomor, bukan id saja. Bot me-reset _id_counter tiap
  // restart sehingga id YANG SAMA (mis. T-1) bisa dipakai task yang beda; kalau hanya id
  // yang dicek, task baru ikut ter-skip "sudah dikerjakan" dan bot terlihat diam.
  function kunciHandled(id, nomor) { return String(id || "") + "|" + String(nomor || ""); }

  function bacaHandled() {
    var h;
    try { h = JSON.parse(sessionStorage.getItem(HANDLED_KEY) || "{}"); } catch (e) { h = {}; }
    if (!h || typeof h !== "object") h = {};
    // Pangkas SAAT BACA. Kalau hanya dipangkas saat tulis, entri lama tidak pernah hilang
    // selama tidak ada task lain yang sukses kirim — padahal itulah saat yang paling perlu
    // bersih, karena id lama masih di sana sementara task baru memakai id yang sama.
    var cut = Date.now() - HANDLED_TTL_MS;
    var berubah = false;
    Object.keys(h).forEach(function (k) { if (!h[k] || h[k] < cut) { delete h[k]; berubah = true; } });
    if (berubah) {
      try { sessionStorage.setItem(HANDLED_KEY, JSON.stringify(h)); } catch (e2) {}
    }
    return h;
  }

  // id+nomo yang SUDAH selesai dikirim — cegah duplikat bila auto-refresh menyusul.
  function tandaiHandled(id, nomor) {
    try {
      var h = bacaHandled();
      h[kunciHandled(id, nomor)] = Date.now();
      sessionStorage.setItem(HANDLED_KEY, JSON.stringify(h));
    } catch (e) {}
  }

  function sudahHandled(id, nomor) {
    return !!bacaHandled()[kunciHandled(id, nomor)];
  }

  function log(msg) {
    try { console.log("[GetEmbassy]", msg); } catch (e) {}
    try {
      var jam = new Date();
      var baris = ("0" + jam.getHours()).slice(-2) + ":" + ("0" + jam.getMinutes()).slice(-2) +
        ":" + ("0" + jam.getSeconds()).slice(-2) + " " + String(msg).slice(0, LOG_CHAR_MAX);
      var arr;
      try { arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]"); } catch (e2) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr.push(baris);
      while (arr.length > LOG_MAX) arr.shift();
      sessionStorage.setItem(LOG_KEY, JSON.stringify(arr));
    } catch (e3) {}
  }

  // Isi buffer log, untuk tombol "📋". Kalau log kosong, tetap kembalikan penanda waktu
  // supaya tidak terlihat seperti "tidak ada yang terjadi" padahal buffer-nya belum sempat
  function ambilLog() {
    var arr = [];
    try {
      var raw = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      if (Array.isArray(raw)) arr = raw;
    } catch (e) {}
    if (!arr.length) return "(belum ada log — bot mungkin belum memproses task apa pun)";
    return arr.join("\n");
  }

  // Padakan URL supaya AGENT_SECRET tidak ikut tersalin ke log/clipboard.
  function urlPendek(u) {
    return String(u || "").replace(/([?&]secret=)[^&]*/i, "$1***");
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
      // Verifikasi sungguhan: return true hanya bila kolom benar-benar berisi nomor,
      // sehingga tombol Cek ditekan dengan input kosong dan hasilnya selalu gagal.
      var isi = String(el.value || "").replace(/\D/g, "");
      if (isi === mau && isi.length > 0) return true;
      log("isiNomor: percobaan " + coba + "/3 gagal, kolom berisi '" + el.value + "'.");
      // Kemungkinan salah kolom → pilih kandidat lain di percobaan berikutnya.
      el = cariInput(el) || el;
    }
    return false;
  }

  // Apakah kolom Nomor Internet saat ini masih memuat nomor yang diharapkan? Dipakai
  // sebelum klik Cek ulang: klik Cek bisa memicu reload penuh, dan kolom pun kembali
  function nomorMasihTerisi(nomor) {
    var mau = String(nomor == null ? "" : nomor).replace(/\D/g, "");
    if (!mau) return false;
    var el = cariInput();
    if (!el) return false;
    return String(el.value || "").replace(/\D/g, "") === mau;
  }

  // Pilih domain di dropdown, lalu VERIFIKASI select benar-benar berganti.
  // o.value, tanpa pernah memastikan select benar-benar berganti — jadi "berhasil" bisa
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
        if (teks.indexOf(domain) < 0) continue;
        var sebelum = s.selectedIndex;
        s.selectedIndex = k;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        s.dispatchEvent(new Event("input", { bubbles: true }));
        if (s.selectedIndex !== sebelum) {
          log("Domain → " + domain + " (opsi #" + k + " '" + o.text + "' di select #" + i + ").");
          return true;
        }
        // Cadangan: nilai option bisa string kosong sehingga .value tidak menandai apa pun.
        s.value = o.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        if (String(s.value) === String(o.value) && o.value !== "") {
          log("Domain → " + domain + " (fallback .value, select #" + i + ").");
          return true;
        }
        log("Domain '" + domain + "' ADA di select #" + i + " tapi select tidak bereaksi " +
          "(selectedIndex " + sebelum + " → " + s.selectedIndex + ").");
      }
    }
    if (klikTeks(domain, false)) {
      log("Domain → " + domain + " lewat klik teks (bukan <select>).");
      return true;
    }
    log("Domain '" + domain + "' tidak ditemukan: tidak ada <select> domain yang memuatnya, dan teksnya tidak bisa diklik.");
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

  // Baca nilai paket (Paket Radius / Paket PCRF) dari tabel hasil Gladius.
  // Bentuk render: (a) key-value horizontal, (b) header kolom + nilai di baris bawah,
  var _BATAS_SCAN_KOLOM = 30;

  // Fragmen regex yang dipakai bersama oleh pola label dan pola "label + nilai",
  // supaya keduanya pasti sepakat soal bentuk header gabungan. Tanpa ini, header
  var ATURAN_SATU_LABEL_PAKET = "(?:" + esc(TEKS_KOLOM_PAKET) + "|" + esc(TEKS_KOLOM_PAKET_ALT) + ")";
  var OPSIONAL_PARENS = "(?:\\s*\\([^)]*\\))?";
  var PEMISAH_LABEL = "\\s*(?:\\/|\\||&|,|\\bdan\\b|\\bor\\b|\\bx\\b)\\s*";

  // Label "Paket Radius" / "Paket PCRF" yang diperluas: boleh diakhiri sebuah grup
  // kurung untuk unit/sifat, mis. "Paket Radius (Mbps)" — tanpa menerima teks bebas.
  var _polaLabelPaket = null;
  function polaLabelPaket() {
    if (!_polaLabelPaket) {
      var satu = ATURAN_SATU_LABEL_PAKET;
      _polaLabelPaket = new RegExp(
        "^\\s*" + satu + OPSIONAL_PARENS +
        "(?:" + PEMISAH_LABEL + satu + OPSIONAL_PARENS + ")*" +
        "\\s*[:=-]?\\s*$",
        "i"
      );
    }
    return _polaLabelPaket;
  }

  // Jalur (c): "label + nilai dalam satu sel". Nilai WAJIB tertangkap di grup terpisah.
  var _polaSatuSelPaket = null;
  function polaSatuSelPaket() {
    if (!_polaSatuSelPaket) {
      var satu = ATURAN_SATU_LABEL_PAKET;
      _polaSatuSelPaket = new RegExp(
        "^\\s*" + satu + OPSIONAL_PARENS +
        "(?:" + PEMISAH_LABEL + satu + OPSIONAL_PARENS + ")*" +
        // Label lalu nilai. Pemisah boleh ":" "=" "-" ATAU spasi saja. Backtrack ke spasi
        // wajib ada, kalau tidak "Paket Radius 10 Mbps" tak akan tertangkap.
        "(?:\\s*[:=-]|\\s+)\\s*(\\S.*)$",
        "i"
      );
    }
    return _polaSatuSelPaket;
  }

  function bacaPaket() {
    if (dialogMenyatakanKosong()) return "";
    var polaLabel = polaLabelPaket();
    var polaSatuSel = polaSatuSelPaket();
    var jejak = [];
    var akar = akarSemua();
    var a, i, c, j, s;

    for (a = 0; a < akar.length; a++) {
      var root = akar[a];
      var nama = namaAkar(root);
      var rows = qsSemua(root, "tr");
      var selLabel = [];

      for (i = 0; i < rows.length; i++) {
        s = rows[i].querySelectorAll("td,th");
        if (!s.length) continue;

        // (c) label + nilai dalam satu sel: "Paket Radius : 10 Mbps"
        // Grup tangkap PERTAMA adalah nilai (label sudah terpisah dari nilai di dalam
        for (c = 0; c < s.length; c++) {
          var isi = normTeks(s[c].innerText || s[c].textContent);
          // Sel yang SELURUHNYA label murni tidak mungkin jadi baris nilai. Dicek lebih
          // dulu karena pola satu-sel bisa mundur (backtrack): grup parens " (Mbps)"
          var m = isi.match(polaSatuSel);
          if (!m) continue;
          // Grup 1 kosong = hanya label ("Paket Radius" tanpa nilai).
          if (m[1] === undefined) continue;
          var sisa = normTeks(m[1]);
          if (!sisa) continue;
          if (terimaNilaiPaket(sisa)) { catatPaketJejak(nama + " satu-sel", sisa); return sisa; }
          jejak.push(nama + " satu-sel ditolak: " + JSON.stringify(sisa));
        }

        for (j = 0; j < s.length; j++) {
          if (polaLabel.test(normTeks(s[j].innerText || s[j].textContent))) {
            selLabel.push({ baris: i, kolom: j, sel: s });
          }
        }
      }

      if (selLabel.length) {
        // (b) header kolom: telusuri ke BAWAH pada indeks kolom yang sama.
        // Sel yang isinya juga berlabel paket harus diabaikan — itu header, bukan nilai.
        for (i = 0; i < selLabel.length; i++) {
          var L = selLabel[i];
          var batas = Math.min(rows.length, L.baris + 1 + _BATAS_SCAN_KOLOM);
          for (var r = L.baris + 1; r < batas; r++) {
            var selBawah = rows[r].querySelectorAll("td,th");
            if (L.kolom >= selBawah.length) break;
            var v = normTeks(selBawah[L.kolom].innerText || selBawah[L.kolom].textContent);
            if (!v) continue;
            if (polaLabel.test(v)) continue;
            if (terimaNilaiPaket(v)) { catatPaketJejak(nama + " kolom-" + (L.kolom + 1), v); return v; }
            jejak.push(nama + " kolom " + (L.kolom + 1) + " ditolak: " + JSON.stringify(v));
          }
        }

        // (a) key-value: nilai di sel sebelah kanan. Lewati bila tetangganya <th>.
        for (i = 0; i < selLabel.length; i++) {
          var K = selLabel[i];
          if (K.kolom + 1 >= K.sel.length) continue;
          var nx = K.sel[K.kolom + 1];
          if (String(nx.tagName || "").toUpperCase() === "TH") continue;
          var n = normTeks(nx.innerText || nx.textContent);
          if (terimaNilaiPaket(n)) { catatPaketJejak(nama + " sel-berikutnya", n); return n; }
        }

        // Label ketemu di akar ini tapi nilai tidak → jangan lanjut cari akar lain
        // hanya atas dasar teks yang sama; tapi kalau masih kosong total di atas,
        var nilaiTabel = bacaPaketJalurNonTabel(root, polaLabel, polaSatuSel, jejak, nama);
        if (nilaiTabel) { catatPaketJejak(nama + " saudara", nilaiTabel); return nilaiTabel; }
        continue;
      }

      var nilaiNonTabel = bacaPaketJalurNonTabel(root, polaLabel, polaSatuSel, jejak, nama);
      if (nilaiNonTabel) { catatPaketJejak(nama + " saudara", nilaiNonTabel); return nilaiNonTabel; }
    }

    catatPaketJejak("", jejak);
    return "";
  }

  // Jalur cadangan untuk hasil yang BUKAN tabel (div/span/li/dll.): cari ELEMEN DAUN
  // berlabel Paket Radius, lalu ambil teks saudara/vicinanya. Versi tersimpan di
  function bacaPaketJalurNonTabel(root, polaLabel, polaSatuSel, jejak, nama) {
    var semua = [];
    try { semua = root.querySelectorAll("div,span,li,td,th,p,label,dt,dd"); } catch (e) { return ""; }
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      if (el.children && el.children.length > 0) continue; // hanya elemen daun
      var t = normTeks(el.innerText || el.textContent);
      if (!t) continue;
      var labelMurni = polaLabel.test(t);
      if (!labelMurni) {
        // Sama seperti jalur tabel: sel label murni ("Paket Radius (Mbps)", "Paket
        // Radius / Paket PCRF") tidak boleh salah dibaca jadi nilai lewat backtrack pola.
        var m = t.match(polaSatuSel);
        if (m && m[1] !== undefined) {
          var sisa = normTeks(m[1]);
          if (sisa && terimaNilaiPaket(sisa)) return sisa;
        }
      }
      if (!labelMurni) continue;
      var nx = el.nextElementSibling;
      if (nx) {
        var v = normTeks(nx.innerText || nx.textContent);
        if (v && terimaNilaiPaket(v)) return v;
      }
      var p = el.parentElement;
      if (p && p.children && p.children.length === 2 && p.children[0] === el) {
        var v2 = normTeks(p.children[1].innerText || p.children[1].textContent);
        if (v2 && terimaNilaiPaket(v2)) return v2;
      }
    }
    return "";
  }

  // Alat bantu debug, bisa dipanggil manual dari Console: GetEmbassyDebug.struktur()
  // Mencatat di mana teks "paket radius/pcrf" benar-benar hidup (dokumen utama,
  function mtgStrukturPaket() {
    var out = [];
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var root = akar[a];
      var nama = namaAkar(root);
      var semua = [];
      try { semua = root.querySelectorAll("*"); } catch (e) { continue; }
      for (var i = 0; i < semua.length; i++) {
        var el = semua[i];
        var t = normTeks(el.innerText || el.textContent);
        if (!t || t.length > 200) continue;
        if (!/paket\s*(radius|pcrf)/i.test(t)) continue;
        out.push({ akar: nama, tag: el.tagName, kelas: String(el.className || "").slice(0, 40), teks: t.slice(0, 100) });
        if (out.length >= 25) break;
      }
    }
    try {
      if (typeof console.table === "function") console.table(out);
      else console.log(out);
    } catch (e) {}
    return out;
  }

  // Alat bantu debug LFU: cari posisi teks "Last Five Usage" + panelnya (tag, class,
  // rect, jumlah baris). Kalau deteksi LFU masih salah, hasil ini menunjukkan apakah
  function mtgStrukturLfu() {
    var out = [];
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var root = akar[a];
      var nama = namaAkar(root);
      var semua = [];
      try { semua = root.querySelectorAll("table,div,section,ul,ol"); } catch (e) { continue; }
      for (var i = 0; i < semua.length; i++) {
        var el = semua[i];
        var t = normTeks(el.innerText || el.textContent);
        if (!t || t.length > 4000) continue;
        if (!/last\s*five\s*usage/i.test(t)) continue;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        var isi = [];
        try { isi = el.querySelectorAll("table tr, ul li, ol li"); } catch (e2) {}
        out.push({
          akar: nama,
          tag: el.tagName,
          kelas: String(el.className || "").slice(0, 40),
          terlihat: !!(r && r.width > 0 && r.height > 0),
          rect: r ? Math.round(r.width) + "x" + Math.round(r.height) : "-",
          baris: isi.length,
          teks: t.slice(0, 120),
        });
        if (out.length >= 25) break;
      }
    }
    try {
      if (typeof console.table === "function") console.table(out);
      else console.log(out);
    } catch (e) {}
    return out;
  }

  // Alat bantu debug status Password: cari semua elemen berlabel "status" lintas konteks
  // (dokumen utama + iframe + shadow) plus nilai pasangannya. Dipakai kalau bacaStatusPassword
  function mtgStrukturPassword() {
    var out = [];
    var akar = akarSemua();
    var pola = /status\s*(password|pelanggan|internet)?/i;
    for (var a = 0; a < akar.length; a++) {
      var root = akar[a];
      var nama = namaAkar(root);
      var semua = [];
      try { semua = qsSemua(root, "td, th, label, span, div, table"); } catch (e) { continue; }
      for (var i = 0; i < semua.length; i++) {
        var el = semua[i];
        var t = normTeks(el.innerText || el.textContent);
        if (!t || t.length > 100) continue;
        if (!pola.test(t)) continue;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        out.push({
          akar: nama,
          tag: el.tagName,
          kelas: String(el.className || "").slice(0, 40),
          terlihat: !!(r && r.width > 0 && r.height > 0),
          teks: t.slice(0, 60),
        });
        if (out.length >= 25) break;
      }
    }
    try {
      if (typeof console.table === "function") console.table(out);
      else console.log(out);
    } catch (e) {}
    return out;
  }

  try {
    window.GetEmbassyDebug = {
      strukturPaket: mtgStrukturPaket,
      strukturLfu: mtgStrukturLfu,
      strukturPassword: mtgStrukturPassword,
      bacaPaket: bacaPaket,
      akarSemua: akarSemua,
    };
  } catch (e) {}

  // Nilai paket yang layak diterima.
  // SENGAJA tidak memakai terlihatNotifikasi(): aturan ">60 karakter = notifikasi" itu
  var POLA_SISA_LABEL_PAKET = /\bpaket\b/i;
  function terimaNilaiPaket(nilai) {
    nilai = normTeks(nilai);
    if (!nilai) return false;
    if (POLA_TIDAK_DITEMUKAN.test(nilai)) return false;
    if (nilaiKosong(nilai)) return false;
    // Netsa pengaman: nilai paket yang sah TIDAK PERNAH memuat kata "paket". Kalau
    // memuat, berarti ini sisa label(header gabungan) yang lolos dari pemisahan label,
    if (POLA_SISA_LABEL_PAKET.test(nilai)) return false;
    return true;
  }

  // Jejak diagnostik. Memoize supaya polling tiap 500ms tidak membanjiri console.
  var _paketJejakTerakhir = null;
  function catatPaketJejak(cara, nilai) {
    var pesan = "[GetEmbassy] paket " + (cara ? "TERBACA (via " + cara + "): " + JSON.stringify(nilai)
      : "TIDAK terbaca. Kandidat yang ditolak: " + ((nilai && nilai.length) ? nilai.join(" | ") : "(tidak ada sel berlabel Paket Radius sama sekali)"));
    if (pesan === _paketJejakTerakhir) return;
    _paketJejakTerakhir = pesan;
    try { console.log(pesan); } catch (e) {}
  }

  function nilaiKosong(nilai) {
    nilai = normTeks(nilai).toLowerCase();
    return NILAI_PAKET_KOSONG.indexOf(nilai) >= 0;
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
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var semua = qsSemua(akar[a], "td,th,tr,div,span,label,table");
      for (var i = 0; i < semua.length; i++) {
        var el = semua[i];
        var t = normTeks(el.innerText || el.textContent || "");
        if (!t || t.length > 4000) continue;
        if (!t.match(pat) && !t.match(patLfu)) continue;
        // rect di koordinat HALAMAN UTAMA, bukan relative iframe — kalau hasilnya
        // dirender di dalam frame, kotak potret harus mengikuti posisi frame tsb.
        var r = rectDiHalaman(el);
        if (r.right <= r.left || r.bottom <= r.top) continue;
        if (r.bottom - r.top > 20000) continue;
        box = gabungRect(box, r);
      }
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

  function namaHalaman(jenis) {
    return jenis === "password" ? "Password Check" : "Embassy";
  }

  function diHalamanTarget(jenis) {
    return pathSekarang() === pathTarget(jenis);
  }

  // Sesi Gladius sudah tidak terautentikasi? Tanpa cek ini bot tetap saja mencoba
  // mengisi "Internet Number" ke kolom NIK di halaman login, gagal, lalu mengulang
  // puluhan kali tanpa pernah sampai ke halaman target — gejalanya terlihat seperti
  // "bot mati", padahal penyebabnya session expired.
  //
  // Sinyal: path /public/login (dan turunannya msg/otp), form NIK, atau banner
  // "Belum Di Daftarkan" yang Gladius tampilkan saat akun tidak terdaftar.
  var POLA_LOGIN = /belum\s+(di\s+)?daftar|tidak\s+terdaftar|silahkan\s+koordinasi/i;

  function sesiTdkValid() {
    var p = String(location.pathname || "");
    if (p.indexOf("/public/login") === 0 || p.indexOf("/public/otp/") === 0) return true;
    if (qsSemua(document, "input[name='uname'], input#uname, input[name='captcha\\[input\\]']").length) {
      return true;
    }
    var banner = qsSemua(document, ".alert-danger, .alert-warning");
    for (var i = 0; i < banner.length; i++) {
      if (POLA_LOGIN.test(teksEl(banner[i]))) return true;
    }
    return false;
  }

  // Hentikan seluruh siklus, bukan cuma task ini: setiap task berikutnya akan gagal
  // dengan sebab yang sama, dan tanpa henti itu antrian hanya berputar di tempat.
  var SESI_HABIS_ATAS = false;
  // Jeda setelah kabari sesi habis. Cukup untuk memberi waktu login, dan tetap
  // encapsulate kegagalan: bot diam sebentar lalu mencoba lagi bila kamu belum sempat.
  var SESI_HABIS_TUNGGU_MS = 30000;

  async function stopkarenaSesiHabis(st) {
    if (SESI_HABIS_ATAS) return;
    SESI_HABIS_ATAS = true;
    var pesan = "Sesi Gladius habis (halaman login muncul). Silakan login ulang di tab " +
      "browser, lalu bot akan lanjut sendiri dari antrian.";
    setStatus("🔴 Sesi Gladius habis — login ulang dulu");
    log("SESI HABIS: " + pesan);
    if (st) {
      await gagalkan(st, pesan);
    } else {
      // Tidak ada task aktif: tetap kabari lewat task pending pertama supaya
      // pemilik bot tahu tanpa harus membuka log.
      try {
        var pending = await ambilAntrian();
        if (pending && pending.length) {
          await gagalkan({ id: pending[0].id, nomor: pending[0].nomor,
                           jenis: pending[0].jenis, chat_id: pending[0].chat_id,
                           message_id: pending[0].message_id }, pesan);
        }
      } catch (e) {
        log("Gagal mengkabari sesi habis: " + e);
      }
    }
  }

  // Tunggu sampai location.pathname benar-benar jadi target. Hanya berguna saat
  // navigasi TOLAK (mis. dialog beforeunload yang menahan, atau URL yang diblokir):
  function tungguPathBerubah(target, maksMs) {
    return new Promise(function (resolve) {
      var akhir = Date.now() + (maksMs || 8000);
      (function cek() {
        if (pathSekarang() === target) { resolve(true); return; }
        if (Date.now() >= akhir) { resolve(false); return; }
        setTimeout(cek, 250);
      })();
    });
  }

  // Navigasi langsung ke URL target. Klik menu sidebar DIHAPUS karena homepage Gladius
  // tidak punya sidebar (hanya kartu dashboard), sehingga tungguMenu selalu kehabisan
  async function bukaHalaman(jenis) {
    var target = pathTarget(jenis);
    if (diHalamanTarget(jenis)) return "ready";
    setStatus("🔎 Membuka halaman " + namaHalaman(jenis) + " ...");
    var url = targetURL(jenis);
    var awal = pathSekarang();
    for (var percobaan = 1; percobaan <= 3; percobaan++) {
      log("Navigasi #" + percobaan + ": " + pathSekarang() + " → " + target + " (" + urlPendek(url) + ")");
      try {
        if (percobaan === 1) location.assign(url);
        else location.replace(url);
      } catch (e) {
        log("location." + (percobaan === 1 ? "assign" : "replace") + " melempar: " + e);
      }
      // Halaman masih hidup berarti navigasi belum terjadi.
      if (await tungguPathBerubah(target, 8000)) return "navigating";
      log("Navigasi #" + percobaan + " tidak memberi hasil (path masih " + pathSekarang() + ")");
    }
    log("Navigasi GAGAL ke " + target + " setelah 3 percobaan. Awal " + awal +
      ", akhir " + pathSekarang() + ". Dugaan: sesi Gladius habis / halaman memantul ke login.");
    return "gagal";
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
          // Kalau kehabisan waktu tanpa nilai, katakan terus terang di console.
          // diam saja, sehingga "paket tidak terbaca" indistinguishable dari "halaman lambat".
          if (nilaiKosong(v) && !dialogMenyatakanKosong()) {
            try {
              console.log("[GetEmbassy] paket tidak terbaca dalam " + maxMs + "ms — selector tabel hasil tidak mengenali layout Gladius ini.");
            } catch (e) {}
          }
          resolve(v);
          return;
        }
        setTimeout(poll, 500);
      })();
    });
  }

  // Pagar rekursi lanjutDariCek(). Fungsi ini memanggil dirinya sendiri setelah tiap
  // percobaan domain; tanpa batas eksplisit, kombinasi apa pun yang tidak pernah maju
  var BATAS_LANJUT_CEK = 12;

  // Setelah tombol "Cek" ditekan (inline ATAU resume pasca-reload): baca hasilnya.
  async function lanjutDariCek(st, kedalaman) {
    kedalaman = kedalaman || 0;
    if (kedalaman > BATAS_LANJUT_CEK) {
      log("Batas " + BATAS_LANJUT_CEK + " percobaan habis untuk " + st.nomor +
        " → hentikan, kirim screenshot apa adanya.");
      st.paket_ok = false;
      st.alasan = "Proses berhenti setelah " + BATAS_LANJUT_CEK +
        " percobaan tanpa paket terbaca.";
      return lanjutKeScreenshot(st);
    }
    var paket = await tungguHasilPaket(30000);
    if (!nilaiKosong(paket)) {
      st.paket_ok = true;
      st.domain = bacaDomainTerpilih() || null;
      // Kabari bahwa data inti SUDAH benar, supaya pengguna tidak mengira proses macet
      // selama tahap LFU berjalan di belakang layar.
      setStatus("✅ " + st.nomor + " · paket " + (st.domain || "-") + " terbaca · ambil LFU");
      return lanjutKeLfu(st);
    }

    var domain = domainBerikutnya(st);
    if (!domain) {
      // SEMUA domain habis dicoba → tetap kirim screenshot (tanpa Last Five Usage).
      // Bedakan DUA sebab yang tadinya tercampur jadi satu: dropdown domain yang tidak
      st.paket_ok = false;
      st.alasan = (st.domain_gagal || []).length
        ? "Tidak berhasil menguji semua domain — " + st.domain_gagal.join("; ") + "."
        : "Paket tidak ditemukan pada semua domain (" + (st.coba || []).join(", ") + ").";
      return lanjutKeScreenshot(st);
    }

    st.coba.push(domain);
    st.attempts++;
    st.step = "cek";
    simpanState(st);
    setStatus("⚙️ " + st.nomor + " · coba domain " + domain);
    // Nomor bisa hilang karena reload penuh saat Cek sebelumnya. Isi ulang bila kosong,
    // jangan sampai klik Cek dengan kolom kosong lalu mengulang kegagalan yang sama.
    if (!nomorMasihTerisi(st.nomor)) {
      log("Kolom nomor kosong sebelum retry domain " + domain + " → isi ulang " + st.nomor + ".");
      if (!isiNomor(st.nomor)) {
        throw new Error("Gagal mengisi ulang Nomor Internet saat coba domain " + domain + ".");
      }
    }
    if (!pilihDomain(domain)) {
      st.domain_gagal = (st.domain_gagal || []).concat([domain + " (dropdown tidak berubah)"]);
      log("Gagal memilih domain " + domain + " → coba domain berikutnya.");
      await wait(1200);
      return lanjutDariCek(st, kedalaman + 1);
    }
    if (!klikTeks(TEKS_TOMBOL_CEK, true)) {
      st.domain_gagal = (st.domain_gagal || []).concat([domain + " (tombol Cek tidak diklik)"]);
      log("Domain " + domain + " terpasang tapi tombol '" + TEKS_TOMBOL_CEK +
        "' tidak bisa diklik → lewati domain ini.");
      await wait(1200);
      return lanjutDariCek(st, kedalaman + 1);
    }
    // Klik Cek memicu reload halaman. Ini reload milik kita, catat terpisah.
    st.reload_ours = (st.reload_ours || 0) + 1;
    simpanState(st);
    await tungguTenang(WAIT_HASIL_MS, sidikJari());
    // Bila klik tadi memicu reload, bagian ini mati → resume yang meneruskan.
    return lanjutDariCek(bacaState() || st, kedalaman + 1);
  }

  // Label status yang dipakai tabel hasil Gladius. Lebih lebar dari sekadar "status"
  // supaya tidak tergantung pada satu istilah.
  var LABEL_STATUS_PW = [
    "status password", "password status", "status pelanggan", "status paket",
    "status internet", "status langganan", "status",
  ];

  // offsetParent SALAH untuk elemen position:fixed — containing block-nya viewport, jadi
  // offsetParent tetap null meski elemennya jelas terlihat. Panel hasil Gladius memang
  function terlihatReally(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
    } catch (e) { return false; }
    try {
      var cs = window.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")) {
        return false;
      }
    } catch (e2) {}
    return true;
  }

  // Semua kandidat elemen berlabel status, bukan cuma yang pertama.
  // mengembalikan kandidat PERTAMA di urutan DOM; kalau ada "Status" lain di halaman
  function kumpulkanStatusPassword() {
    var out = [];
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var nodes = [];
      try {
        nodes = qsSemua(akar[a], "td, th, label, span, div, p, li, dt, dd, strong, b, h1, h2, h3, h4");
      } catch (e) { continue; }
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var t = teksEl(el).toLowerCase();
        if (!t || t.length > 300) continue;
        for (var j = 0; j < LABEL_STATUS_PW.length; j++) {
          var L = LABEL_STATUS_PW[j];
          if (t === L || t.indexOf(L + " ") >= 0 || t.indexOf(L + ":") >= 0 || t.indexOf(L + "-") >= 0) {
            // Elemen yang teksnya jauh lebih besar dari labelnya adalah container/tabel
            // besar, bukan sel status — jangan dipakai sebagai titik awal pembacaan.
            if (t.length > L.length + 120) break;
            out.push(el);
            break;
          }
        }
      }
    }
    // Yang terlihat didahulukan: label tersembunyi bisa milik widget lain.
    out.sort(function (x, y) {
      return (terlihatReally(y) ? 1 : 0) - (terlihatReally(x) ? 1 : 0);
    });
    return out;
  }

  function cariElemenStatusPassword() {
    var all = kumpulkanStatusPassword();
    for (var i = 0; i < all.length; i++) if (terlihatReally(all[i])) return all[i];
    // Tidak ada yang "terlihat" — tetap coba yang pertama daripada menyerah, karena panel
    // hasil kadang memang belum selesai tampil.
    return all.length ? all[0] : null;
  }

  // Status tidak terbaca TIDAK lagi ditulis sebagai kalimat "tidak ditemukan" karena
  // ikut masuk ke caption Telegram dan menyesatkan (data sebenarnya ada, hanya belum
  var STATUS_PW_TERBACA = false;

  // Alasan penolakan terakhir untuk log.
  // sehingga "status tidak terbaca" tidak bisa dibedakan dari "tabelnya belum selesai
  var _alasanStatusPw = null;
  function catatStatusPw(berhasil, alasan) {
    if (berhasil) {
      if (_alasanStatusPw !== "") log("Status password: TERBACA.");
      _alasanStatusPw = "";
      return;
    }
    if (alasan && _alasanStatusPw !== alasan) {
      _alasanStatusPw = alasan;
      log("Status password: belum terbaca — " + alasan);
    }
  }

  function bacaStatusPassword() {
    STATUS_PW_TERBACA = false;
    var labels = LABEL_STATUS_PW;
    // Sama seperti cariElemenStatusPassword: tabel status bisa hidup di iframe yang
    // dirender halaman Password. qsSemua menembus iframe+shadow, jadi pemindai ini
    var alasan = [];
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var tables = qsSemua(akar[a], "table");
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
              // CADANGAN: indeks header tidak selalu sejajar dengan indeks sel data
              // (colspan/rowspan, atau tabel yang <th>-nya hilang). Versi lama hanya
              var urutan = [];
              if (dataCells[h]) urutan.push(dataCells[h]);
              for (var q = 0; q < dataCells.length; q++) {
                if (q !== h) urutan.push(dataCells[q]);
              }
              for (var u = 0; u < urutan.length; u++) {
                var statusValue = teksEl(urutan[u]);
                if (!statusValue) continue;
                if (statusValue.toLowerCase() === headerText) continue; // masih label
                if (terlihatNotifikasi(statusValue)) {
                  alasan.push("sel '" + statusValue.slice(0, 40) + "' ditolak (terbaca notifikasi)");
                  continue;
                }
                STATUS_PW_TERBACA = true;
                catatStatusPw(true, "");
                return statusValue.slice(0, 200);
              }
              alasan.push("semua sel baris " + (ri + 1) + " kosong/ditolak di bawah header '" +
                headerText + "'");
            }
          }
        }
      }
    }
    // Coba SETIAP kandidat berlabel status, bukan hanya yang pertama. Halaman Gladius
    // punya lebih dari satu tempat yang bisa memuat kata "status", dan versi lama berhenti
    var kandidat = kumpulkanStatusPassword();
    if (!kandidat.length) {
      alasan.push("label status tidak ditemukan di halaman mana pun");
      catatStatusPw(false, ringkasAlasan(alasan));
      return "";
    }
    alasan.push(kandidat.length + " kandidat berlabel status diperiksa");
    for (var ki = 0; ki < kandidat.length && ki < 15; ki++) {
      var el = kandidat[ki];
      var labelText = teksEl(el).toLowerCase();

      // (i) di dalam baris tabel: nilai = sel lain yang bukan label.
      var row = el.closest("tr");
      if (row) {
        var cells = row.querySelectorAll("td, th");
        for (var i = 0; i < cells.length; i++) {
          if (cells[i] === el) continue;
          var value = teksEl(cells[i]);
          if (!value) continue;
          if (value.toLowerCase() === labelText) continue;
          if (terlihatNotifikasi(value)) {
            alasan.push("sel '" + value.slice(0, 40) + "' ditolak (terbaca notifikasi)");
            continue;
          }
          STATUS_PW_TERBACA = true;
          catatStatusPw(true, "");
          return value.slice(0, 200);
        }
        alasan.push("baris '" + labelText.slice(0, 30) + "' tidak punya sel lain yang berisi");
      }

      // (ii) saudara langsung (layout non-tabel / definition list).
      var sibling = el.nextElementSibling;
      if (sibling) {
        var siblingText = teksEl(sibling);
        if (siblingText && siblingText.length <= 200 && !terlihatNotifikasi(siblingText)) {
          STATUS_PW_TERBACA = true;
          catatStatusPw(true, "");
          return siblingText;
        }
        if (siblingText) {
          alasan.push("saudara '" + labelText.slice(0, 20) + "' berisi '" +
            siblingText.slice(0, 40) + "' (ditolak)");
        }
      }

      // (iii) inline di dalam teksnya sendiri: "Status: Aktif".
      var text = teksEl(el);
      var match = text.match(/status(?:\s+(?:password|pelanggan|paket|internet|langganan))?\s*[:\-]\s*(.+)$/i);
      if (match && match[1]) {
        var mv = match[1].trim();
        if (!terlihatNotifikasi(mv)) {
          STATUS_PW_TERBACA = true;
          catatStatusPw(true, "");
          return mv.slice(0, 200);
        }
      }
    }
    // Fallback utama: password muncul sebagai TEKS DI BAWAH TOMBOL CHECK, bukan di
    // tabel berlabel "Status". Semua logika tabel di atas jadi tidak berguna untuk
    // halaman ini. Lihat bacaPasswordDiBawahTombol().
    var bawah = bacaPasswordDiBawahTombol();
    if (bawah) {
      STATUS_PW_TERBACA = true;
      catatStatusPw(true, "");
      return bawah;
    }
    alasan.push("tidak ada label status, dan tidak ada teks hasil di bawah tombol Check");
    catatStatusPw(false, ringkasAlasan(alasan));
    return "";
  }

  // Password Check Gladius memunculkan password sebagai teks polos tepat DI BAWAH tombol
  // "Check" begitu nomor dikirim — tidak pernah sebagai tabel berlabel "Status".
  //
  // Strategi: pakai posisi, bukan nama class/id, karena markup-nya tidak kita adopter.
  // Kumpulkan elemen yang rect-nya DI BAWAH tombol dan sedekat mungkin dengannya, lalu
  // ambil teks daun pertama yang bukan navigasi/footer/penjelasan.
  var BUANG_TEKS_BAWAH =
    /^(pemberitahuan|copyright|all rights|faq|contact us|log in|logout|home|dashboard|terms|privacy|help|support|cara pakai|©|\d{4}\s*[-–])/i;

  function bacaPasswordDiBawahTombol() {
    var btn = cariTeks(TEKS_TOMBOL_PASSWORD, true) || cariTeks("Check", true);
    if (!btn || !terlihatReally(btn)) return "";
    var rbT = rectDiHalaman(btn);

    // Kandidat: elemen daun yang muncul di bawah tombol.
    var semua = qsSemua(document, "div, span, p, td, dd, li, b, strong, h3, h4, code, font");
    var best = null, bestSkor = -1;
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      // Elemen daun saja: yang punya elemen anak berteks berarti container, bukan nilai.
      var anakTeks = 0;
      var kids = el.children;
      for (var k = 0; k < kids.length; k++) {
        if (normTeks(kids[k].textContent)) anakTeks++;
      }
      if (anakTeks > 0) continue;
      if (!terlihatReally(el)) continue;
      var t = normTeks(el.innerText || el.textContent);
      if (!t || t.length > 120) continue;
      if (BUANG_TEKS_BAWAH.test(t)) continue;
      if (POLA_TIDAK_DITEMUKAN.test(t)) continue;
      // Jangan ambil teks tombol atau input yang lagi diketik.
      if (el.closest("form") && el.querySelector("input, select, textarea, button")) continue;
      var r = rectDiHalaman(el);
      // Harus benar-benar DI BAWAH tombol, dan sedekat mungkin (jarak vertikal kecil).
      var dy = r.top - rbT.bottom;
      if (dy < -4) continue;
      if (dy > 600) continue;
      // Prioritaskan yang paling dekat ke tombol, lalu yang paling pendek (nilai, bukan paragraf).
      var skor = dy + Math.max(0, t.length - 40);
      if (skor < bestSkor) { bestSkor = skor; best = t; }
    }
    if (!best) return "";
    // Buang label yang menempel: "Password: abc" -> "abc".
    var m = best.match(/password\s*[:\-]?\s*(.+)$/i);
    if (m && m[1]) best = normTeks(m[1]);
    if (!best) return "";
    log("Password ditemukan di bawah tombol Check: '" + best + "'");
    return best.slice(0, 200);
  }

  // Alasan yang dikumpulkan panjang sekali saat polling 500ms; ambil yang paling
  // informatif (yang terakhir) supaya log tidak berputar isi yang sama.
  function ringkasAlasan(alasan) {
    if (!alasan || !alasan.length) return "tidak ada kandidat sama sekali";
    var unik = [];
    for (var i = alasan.length - 1; i >= 0 && unik.length < 3; i--) {
      if (unik.indexOf(alasan[i]) < 0) unik.unshift(alasan[i]);
    }
    return unik.join("; ");
  }

  // Poll status password sampai muncul. Password muncul SEKETIKA setelah Check diklik
  // (teks polos di bawah tombol), jadi 8 dtk sudah sangat longgar — sisa waktu hanya
  // untuk kasus tabel yang merender lambat.
  async function tungguStatusPassword(maxMs) {
    maxMs = maxMs || 8000;
    var mulai = Date.now();
    while (Date.now() - mulai < maxMs) {
      var s = bacaStatusPassword();
      if (s) return s;
      if (dialogMenyatakanKosong()) {
        catatStatusPw(false, "halaman menyatakan data tidak ditemukan (dialog)");
        return "";
      }
      await wait(500);
    }
    var akhir = bacaStatusPassword();
    if (!akhir) {
      // Kehabisan waktu tanpa satu baris log adalah kegagalan diam: dari luar tidak
      // bisa dibedakan "tabelnya belum selesai render" dari "selektor kita salah".
      log("Status password tidak terbaca dalam " + maxMs + "ms. Alasan terakhir: " +
        (_alasanStatusPw || "(tidak ada)") + ". Struktur tabel di halaman:");
      try {
        log("Struktur 'status' di halaman: " + JSON.stringify(mtgStrukturPassword(), null, 1));
      } catch (e) { log("Gagal ambil struktur: " + e); }
    }
    return akhir;
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

    // Sama seperti pembaca status: nilai password bisa berada di iframe, jangan hanya
    // sisir dokumen utama.
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var passwordInputs = qsSemua(akar[a], "input[type='password']");
      for (var i = 0; i < passwordInputs.length; i++) hide(passwordInputs[i]);

      var labelled = qsSemua(akar[a], "[aria-label], [name], [id]");
      for (var j = 0; j < labelled.length; j++) {
        var attrs = [
          labelled[j].getAttribute("aria-label") || "",
          labelled[j].getAttribute("name") || "",
          labelled[j].getAttribute("id") || "",
        ].join(" ");
        if (/password/i.test(attrs)) hide(labelled[j]);
      }

      var cells = qsSemua(akar[a], "td, th");
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
      log("Password: isi nomor " + st.nomor + " (step " + st.step + ").");
      if (!isiNomor(st.nomor)) throw new Error("Gagal mengisi Nomor Internet (kolom tidak ditemukan atau nilai tidak terverifikasi).");
      st.step = "password_hasil";
      st.password_clicked = true;
      simpanState(st);
      log("Password: klik tombol '" + TEKS_TOMBOL_PASSWORD + "', step -> password_hasil.");
      if (!klikTeks(TEKS_TOMBOL_PASSWORD, true)) {
        throw new Error("Tombol '" + TEKS_TOMBOL_PASSWORD + "' tidak ditemukan.");
      }
      await tungguTenang(WAIT_PASSWORD_MS, basis);
    } else {
      log("Password: resume dari step " + st.step + ", tunggu tenang " + WAIT_PASSWORD_MS + "ms.");
      await tungguTenang(WAIT_PASSWORD_MS, basis);
    }
    // Password muncul sebagai teks di bawah tombol, jadi poll selesai begitu ada isi.
    // Sisa timeout hanya untuk halaman yang merender lambat.
    log("Password: poll hasil (maks 8s).");
    var status = await tungguStatusPassword(8000);
    log("Password: terbaca=" + STATUS_PW_TERBACA + ", nilai=" + JSON.stringify(status).slice(0, 80));
    st.status = status;
    st.status_terbaca = STATUS_PW_TERBACA;
    st.step = "password_screenshot";
    simpanState(st);
    return lanjutKeScreenshot(st);
  }

  // Konfirmasi panel Last Five Usage benar-benar terbuka (tombol diklik saja belum cukup).
  // Sebelumnya: filter offsetParent membuang panel modal position:fixed (false negative),
  function lfuSudahTerbuka() {
    if (dialogMenyatakanKosong()) return false;
    var pat = new RegExp(TEKS_TOMBOL_LFU.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    var akar = akarSemua();
    var bukti = 0;
    for (var a = 0; a < akar.length; a++) {
      var semua = qsSemua(akar[a], "table,div,section,ul,ol");
      for (var i = 0; i < semua.length; i++) {
        var el = semua[i];
        try {
          var r = el.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) continue;
        } catch (e) { continue; }
        var t = normTeks(el.innerText || el.textContent);
        if (!t || t.length > 4000) continue;
        if (!pat.test(t)) continue;
        // Panel LFU dianggap terbuka bila ada isi tabel/baris di dalamnya yang bukan
        // sekadar tombol dan bukan teks "tidak ditemukan".
        var isi = el.querySelectorAll("table tr, ul li, ol li");
        if (!isi.length && el.tagName === "TABLE") isi = [el]; // tabel itu sendiri
        for (var j = 0; j < isi.length; j++) {
          var baris = normTeks(isi[j].innerText || isi[j].textContent);
          if (!baris || baris.length > 2000) continue;
          if (pat.test(baris) && baris.length < 40) continue; // ini tombolnya, bukan isi
          if (POLA_TIDAK_DITEMUKAN.test(baris)) continue;
          bukti++;
        }
      }
    }
    return bukti > 1;
  }

  // Poll sampai tabel Last Five Usage benar-benar ter-render. Dipanggil SEGERA setelah
  // klik (bukan setelah tungguTenang), karena panel LFU seringnya terbuka beberapa detik
  async function tungguLfuTerbuka(maxMs) {
    maxMs = maxMs || WAIT_LFU_MS;
    var mulai = Date.now();
    while (Date.now() - mulai < maxMs) {
      if (lfuSudahTerbuka()) return true;
      if (dialogMenyatakanKosong()) return false;
      await wait(250);
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
    if (!st.lfu_clicked && st.lfu_attempts < 2) {
      if (!klikTeks(TEKS_TOMBOL_LFU, true)) {
        // Tombol tidak ketemu → jangan diam-diam: tandai lfu_ok=false + warning,
        // screenshot tetap dikirim (caption nanti memuat catatan LFU gagal).
        setStatus("⚠️ " + st.nomor + " · tombol Last Five Usage tidak ditemukan");
        log("LFU tidak ditemukan untuk " + st.nomor + " (screenshot tetap dikirim).");
        st.lfu_ok = false;
        st.catatan_lfu = "Tombol Last Five Usage tidak ditemukan di halaman hasil.";
        simpanState(st);
        return lanjutKeScreenshot(bacaState() || st);
      }
      st.lfu_clicked = true;
      st.lfu_attempts++;
      // Hanya reload yang DIAKIBATKAN klik kita yang dihitung, supaya auto-refresh
      // Gladius atau reload bawaan halaman tidak ikut menghabiskan anggaran.
      st.reload_ours = (st.reload_ours || 0) + 1;
      simpanState(st);
      // TIDAK tungguTenang di sini: panel LFU bisa kebuka lalu nutup dalam hitungan
      // detik, jadi polling harus mulai langsung. Kalau klik memicu reload → konteks ini
    } else {
      log("LFU resume: tabel sudah ada di halaman, tidak mengklik ulang.");
    }

    st.lfu_ok = await tungguLfuTerbuka(WAIT_LFU_MS);
    simpanState(st);
    // Tutup poll LFU dengan status yang jelas, baik sukses maupun tidak. Tanpa ini layar
    // terlihat "macet" selama WAIT_LFU_MS padahal yang terjadi cuma menunggu render.
    setStatus(
      st.lfu_ok
        ? "✅ " + st.nomor + " · LFU terbaca · lanjut foto"
        : "⚠️ " + st.nomor + " · LFU tidak muncul, tetap lanjut foto"
    );
    return lanjutKeScreenshot(bacaState() || st);
  }

  async function lanjutKeScreenshot(st) {
    // Baca ulang state tepat sebelum foto. Gladius kerap merender beberapa detik
    // setelah langkah sebelumnya, jadi caption dan foto harus berasal dari bacaan
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
      var sp = await tungguStatusPassword(5000);
      if (sp) {
        st.status = sp;
        st.status_terbaca = STATUS_PW_TERBACA;
      }
    }

    setStatus("📸 Ambil screenshot " + st.nomor + " ...");
    var foto = await ambilSS(st.jenis);
    if (!foto) throw new Error("Screenshot kosong.");
    // Rangkum alasan kegagalan supaya bot.py bisa menampilkan SEBABnya, bukan hanya
    // "tidak ditemukan". Tanpa ini semua kegagalan terlihat sama dan tidak bisa
    var alasan = st.alasan || "";
    if (!alasan && st.jenis === "embassy" && !st.paket_ok) {
      alasan = "Paket tidak ditemukan pada domain: " + (st.coba || []).join(", ") + ".";
    }
    if (!alasan && st.jenis === "embassy" && !st.lfu_ok && st.catatan_lfu) {
      alasan = st.catatan_lfu;
    }
    if (!alasan && st.jenis === "password" && !st.status) {
      alasan = "Status belum terbaca. " + (_alasanStatusPw || "");
    }
    var payload = {
      id: st.id,
      chat_id: st.chat_id,
      message_id: st.message_id,
      nomor: st.nomor,
      jenis: st.jenis || "embassy",
      status: st.status || "",
      status_terbaca: st.status_terbaca !== false,
      dialog: DIALOG_TERAKHIR ? DIALOG_TERAKHIR.pesan.slice(0, 200) : "",
      alasan: alasan.slice(0, 300),
      foto: foto,
      paket_ok: !!st.paket_ok,
      lfu_ok: !!st.lfu_ok,
      waktu: fmtWaktu(),
    };
    // Anti-duplikat: tandai SEBELUM mengirim, lalu simpan. Kalau halaman reload di tengah
    // upload, resume akan melihat foto_dikirim dan tahu fotonya sudah ada — tanpa flag ini
    st.foto_dikirim = true;
    simpanState(st);
    setStatus("📤 Kirim hasil " + st.nomor + " ...");
    var resp = null;
    for (var kirimKe = 1; kirimKe <= 3; kirimKe++) {
      resp = await kirimHasil(payload);
      // Putuskan dari `sent`, bukan `ok`. Endpoint membalas {"ok":true,"sent":false} kalau
      // Telegram menolaknya (mis. bad request chat_id, foto terlalu besar). Versi lama
      if (resp && resp.ok && resp.sent) break;
      log("Kirim hasil percobaan " + kirimKe + "/3 gagal: " + JSON.stringify(resp));
      await wait(1500 * kirimKe);
    }
    if (resp && resp.ok && resp.sent) {
      hapusState();
      tandaiHandled(st.id, st.nomor);
      if (resp.data_lengkap === false) {
        setStatus("⚠️ Foto " + st.nomor + " terkirim, data tidak lengkap");
        log("Foto " + st.nomor + " terkirim tapi data TIDAK lengkap: " + (resp.alasan || "-"));
      } else {
        setStatus("✅ Selesai " + st.nomor);
        log("Hasil " + st.nomor + " terkirim lengkap.");
      }
      return;
    }
    // Gagal kirim: JANGAN tandai handled dan jangan hapus state sebelum yakin terkirim.
    // Versi lama menghapus state + menandai handled LANGSUNG setelah memanggil kirim,
    log("Gagal kirim ke server bot setelah 3 percobaan: " + JSON.stringify(resp) +
      " → nomor " + st.nomor + " TIDAK ditandai selesai, akan diulang.");
    setStatus("🔴 Gagal kirim foto " + st.nomor + " · akan diulang");
    hapusState();
  }

  // ===================== PENYELARASAN LANGKAH DENGAN HALAMAN =====================

  // Apakah ada header kolom hasil Paket di halaman? Memakai pola yang sama dengan
  // bacaPaket() supaya "hasil sudah tampil" dan "nilai terbaca" tidak berbeda pendapat.
  function adaJejakPaket() {
    var pola = polaLabelPaket();
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var sel = [];
      try { sel = qsSemua(akar[a], "td, th"); } catch (e) { continue; }
      for (var i = 0; i < sel.length; i++) {
        var t = normTeks(sel[i].innerText || sel[i].textContent);
        if (t && pola.test(t)) return true;
      }
    }
    return false;
  }

  function adaJejakStatus() {
    return kumpulkanStatusPassword().length > 0;
  }

  // Akar masalah "dari menu Embassy berhasil, dari homepage gagal".
  // Mulai dari halaman yang benar, semua berjalan normal. Mulai dari homepage, bukaHalaman
  async function sinkronkanLangkah(st) {
    var jenis = st.jenis;

    if (jenis === "embassy") {
      if (st.step !== "cek") return true;
      if (!await tungguFormTugas("embassy") && !adaJejakPaket()) {
        throw new Error("Form Embassy belum siap.");
      }
      if (adaJejakPaket()) return true;              // hasil sudah ada → cukup dibaca
      if (!st.cek_clicked) {
        // Baru sampai di halaman form lewat navigasi: isi sekarang, sebelum membaca.
        log("Isi Nomor Internet " + st.nomor + " (resume, form baru dimuat dari navigasi).");
      } else if (nomorMasihTerisi(st.nomor)) {
        // Sudah pernah diklik dan kolomnya masih berisi nomornya: bukan form kosong,
        // jangan klik lagi (klik berulang itulah yang memicu reload tanpa akhir).
        return true;
      } else {
        log("Resume: halaman kembali ke form kosong (cek_clicked=true) → ulangi Cek.");
      }
      if (!isiNomor(st.nomor)) {
        throw new Error("Gagal mengisi Nomor Internet (kolom tidak ditemukan atau nilai tidak terverifikasi).");
      }
      if (!klikTeks(TEKS_TOMBOL_CEK, true)) {
        throw new Error("Tombol '" + TEKS_TOMBOL_CEK + "' tidak ditemukan.");
      }
      st.cek_clicked = true;
      simpanState(st);
      await tungguTenang(WAIT_HASIL_MS, sidikJari());
      return true;
    }

    // PASSWORD
    if (st.step === "password_cek") {
      if (!await tungguFormTugas("password")) {
        throw new Error("Form Password Check belum siap.");
      }
      return true;
    }
    if (st.step === "password_hasil") {
      if (adaJejakStatus()) return true;                 // hasil sudah tampil
      if (nomorMasihTerisi(st.nomor)) return true;        // form sudah terisi, tunggu saja
      // Kita mendarat di form kosong padahal state bilang "sudah diklik". Kembalikan
      // langkah ke awal agar lanjutPassword() mengisi nomor dan menekan Cek lagi.
      log("Resume: halaman kembali ke form kosong di step password_hasil → ulangi Cek Password.");
      st.step = "password_cek";
      simpanState(st);
    }
    return true;
  }

  // Dipanggil saat script (baru) terbangun setelah reload — lanjut dari checkpoint.
  async function cobaResumeSetelahReload() {
    var st = bacaState();
    if (!st) return false;
    if (sudahHandled(st.id, st.nomor)) { hapusState(); return false; }
    st.jenis = st.jenis === "password" ? "password" : "embassy";
    // Resume masih task yang sama, jadi dialog TIDAK direset di sini: dialog yang
    // baru saja muncul justru informasi yang mungkin baru kita perlukan. Dialog antar
    st.resume = (st.resume || 0) + 1;
    simpanState(st);
    // Tugas sebelumnya sudah GAGAL, tapi laporannya belum sampai ke bot. Coba ulang HANYA
    // laporan itu -- jangan jalankan ulang seluruh proses, karena Gladius sudah selesai.
    if (st.lapor_pending) {
      if (st.lapor_pending.coba > 5) {
        log("Laporan " + st.nomor + " gagal 5x berturut-turut, menyerah agar tidak mengunci loop.");
        hapusState();
        return true;
      }
      setStatus("📤 Mengirim ulang laporan " + st.nomor + " (percobaan " + (st.lapor_pending.coba + 1) + ")...");
      var terkirim = await laporGagal({
        id: st.id, status: "gagal", pesan: st.lapor_pending.pesan,
        chat_id: st.chat_id, message_id: st.message_id,
        nomor: st.nomor, jenis: st.jenis,
      });
      if (terkirim) {
        log("Laporan ulang " + st.nomor + " akhirnya sampai ke bot.");
        hapusState();
        return true;
      }
      st.lapor_pending.coba = (st.lapor_pending.coba || 0) + 1;
      simpanState(st);
      return true;
    }
    // Tiga batas independen: percobaan domain, reload yang DIAKIBATKAN klik kita, dan
    // jumlah kebangunan script (jaring pengaman untuk auto-refresh tak terduga Gladius).
    if (
      st.attempts >= MAX_ATTEMPTS ||
      (st.reload_ours || 0) > MAX_ATTEMPTS ||
      st.resume > MAX_ATTEMPTS
    ) {
      setStatus("🔴 Gagal (reload berulang) " + st.nomor);
      log("Task " + st.id + " menyerah: attempts=" + st.attempts +
        ", reload_ours=" + (st.reload_ours || 0) + ", resume=" + st.resume +
        ", nav=" + (st.nav || 0) + ", step=" + st.step + ".");
      await gagalkan(st, "Proses berhenti setelah halaman Gladius reload berulang kali. Silakan cek manual atau login ulang.");
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
        st.nav = (st.nav || 0) + 1;
        simpanState(st);
        if (st.nav >= 3) {
          setStatus("🔴 Gagal buka halaman " + st.nomor);
          log("Navigasi gagal " + st.nav + "x untuk " + st.nomor + " (jenis " + st.jenis + ").");
          await gagalkan(st, "Tidak bisa membuka halaman " +
            (st.jenis === "password" ? "Password Check" : "Embassy") +
            " (sesi Gladius mungkin habis). Silakan login ulang.");
        }
        return true;
      }
      st.nav = 0;
      simpanState(st);
      // Foto sudah diambil dan sudah dicoba kirim sebelum halaman ini me-reload. Jangan
      // memotret ulang (duplikat ke user); coba kirim ulang saja. Foto tidak disimpan di
      if (st.foto_dikirim) {
        log("Foto " + st.nomor + " sudah pernah diambil sebelum reload → jangan potret ulang.");
      }
      await sinkronkanLangkah(st);
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
      await gagalkan(st, String(err));
    } finally {
      lagiProses = false;
      idAktif = null;
      updateTampilanAuto();
    }
    return true;
  }

  // Pemakaian html2canvas. Script-nya sendiri datang dari @require (lihat catatan di
  // bagian atas file), jadi tidak ada lagi unduhan runtime dari CDN.
  function html2canvasFn() {
    if (typeof window.html2canvas === "function") return window.html2canvas;
    if (H2C_ASLI) return H2C_ASLI; // jaring pengaman bila halaman menimpanya
    return null;
  }

  // Sembunyikan badge kita sendiri sebelum memotret, laluembalikan apa adanya: foto dikirim
  // ke Telegram sebagai bukti, jadi badge "idle" yang ikut tampil akan terlihat di hasil.
  function sembunyikanUI() {
    var ids = ["getembassy-ui", "getembassy-logbox"];
    var tersembunyi = [];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) continue;
      el.__geDisplayLama = el.style.display;
      el.style.display = "none";
      tersembunyi.push(el);
    }
    return function () {
      for (var i = 0; i < tersembunyi.length; i++) {
        tersembunyi[i].style.display = tersembunyi[i].__geDisplayLama || "";
        tersembunyi[i].__geDisplayLama = null;
      }
    };
  }

  var PIXEL_TRANSPARAN =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  // Gladius menyisipkan <img src="http://graph_image.php/?action=zoom&...">. Perhatikan
  // itu URL ABSOLUT tanpa host: skema http://, lalu "graph_image.php" dianggap sebagai
  function netralkanGambarRusak() {
    var tersentuh = [];
    var akar = akarSemua();
    for (var a = 0; a < akar.length; a++) {
      var imgs = [];
      try { imgs = qsSemua(akar[a], "img"); } catch (e) { continue; }
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        var attr = im.getAttribute("src") || "";
        // Sudah gagal total: selesai tapi nol lebar. Ini kondisi yang dijamin salah.
        var gagal = im.complete && im.naturalWidth === 0;
        // Mixed content: http:// pada halaman https:// pasti dinaikkan ke host palsu.
        var httpMurni = /^http:\/\//i.test(attr);
        if (!gagal && !httpMurni) continue;
        tersentuh.push({ el: im, src: attr, srcset: im.getAttribute("srcset") });
        im.removeAttribute("srcset");
        im.removeAttribute("sizes");
        im.setAttribute("src", PIXEL_TRANSPARAN);
      }
    }
    if (tersentuh.length) {
      log("Netralkan " + tersentuh.length + " gambar rusak sebelum screenshot: " +
        tersentuh.map(function (t) { return t.src.slice(0, 60); }).join(" | ").slice(0, 200));
    }
    return function () {
      for (var i = 0; i < tersentuh.length; i++) {
        var t = tersentuh[i];
        if (!t.el) continue;
        t.el.setAttribute("src", t.src);
        if (t.srcset) t.el.setAttribute("srcset", t.srcset);
      }
    };
  }

  async function ambilSS(jenis) {
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
    var tungguDialog = 0;
    while (!dialogTua(500) && tungguDialog < 30) {
      await wait(500);
      tungguDialog++;
    }
    try { window.scrollTo(0, box.top); } catch (e) {}
    var dataUrl;
    var restoreUI = sembunyikanUI();
    var restoreGambar = netralkanGambarRusak();
    try {
      dataUrl = await new Promise(function (resolve, reject) {
        // Penjaga terakhir: kalau regresi lagi, errornya harus kalimat yang jelas, bukan
        // TypeError mentah yang diteruskan apa adanya ke Telegram.
        var H2C = html2canvasFn();
        if (typeof H2C !== "function") {
          reject(new Error("html2canvas tidak tersedia saat memotret (@require gagal dimuat oleh Tampermonkey)."));
          return;
        }
        H2C(document.body, {
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
          // Batas keras untuk satu gambar. Default html2canvas 15000ms per gambar, jadi
          // beberapa gambar yang lambat bisa menunda screenshot puluhan detik. Dengan
          imageTimeout: 4000,
        }).then(function (canvas) {
          resolve(canvas.toDataURL("image/png"));
        }).catch(reject);
      });
    } finally {
      // Urutan penting: badge lebih dulu, baru blur password. Kalau blur yang lebih dulu
      // dan html2canvas sudah memotret DOM, badge tetap muncul di hasil.
      restoreUI();
      restoreGambar();
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
        if (err) {
          // Cegah spam: /antrian dipoll tiap 5 dtk, log tiap kegagalan akan menyingkirkan
          // 300 baris berguna dalam ~25 menit. Catat yang pertama lalu setiap ke-20.
          _gagalHttp++;
          if (_gagalHttp === 1 || _gagalHttp % 20 === 0) {
            log("HTTP " + (opt.method || "GET") + " " + urlPendek(opt.url) + " → " + err +
              " (gagal beruntun ke-" + _gagalHttp + ")" +
              (err === "timeout" ? " — bot.py hidup? PORT " + PORT_HTTP + " benar?" : ""));
          }
        } else {
          _gagalHttp = 0;
        }
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
    var url = SERVER_BOT + "/antrian?secret=" + encodeURIComponent(AGENT_SECRET);
    var res = await reqGM({ url: url, timeout: 20000 });
    if (res.err) {
      // Dulu kondisi ini dan "antrian kosong" sama-sama mengembalikan [], sehingga
      // bot mati total terlihat identik dengan bot sedang menganggur. Pisahkan sekarang.
      _antrianGagal++;
      if (_antrianGagal === 1 || _antrianGagal % 10 === 0) {
        log("Antrian: GAGAL mengambil dari server bot (" + res.err + "), ke-" +
          _antrianGagal + " berturut-turut.");
      }
      return [];
    }
    try {
      var j = JSON.parse(res.body);
      _antrianGagal = 0;
      if (j && j.ok === false) {
        log("Antrian: server menolak permintaan → " + (j.error || "(tanpa pesan)") +
          " (secret tidak sama dengan bot.py?)");
        return [];
      }
      var isi = (j && j.items) || [];
      if (isi.length > 0) {
        log("Antrian: " + isi.length + " item → " + isi.map(function (x) {
          return x.id + " " + x.jenis + " " + x.nomor;
        }).join(" | "));
      }
      return isi;
    } catch (e) {
      _antrianGagal++;
      log("Antrian: respons bot bukan JSON (awal: " + String(res.body || "").slice(0, 100) +
        ") — bot.py mungkin tidak jalan atau port salah.");
      return [];
    }
  }

  // Timeout dibuat jauh di atas durasi unggah bot (bot.py pakai requests timeout=120).
  // Nilai lama 30s pasti kalah untuk foto besar -> ConnectionAbortedError -> badge
  var KIRIM_TIMEOUT_MS = 180000;

  async function kirimHasil(payload) {
    sentuhAktivitas();
    var url = SERVER_BOT + "/kirim?secret=" + encodeURIComponent(AGENT_SECRET);
    var res = await reqGM({
      method: "POST",
      url: url,
      data: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      timeout: KIRIM_TIMEOUT_MS,
    });
    // Bedakan "server menjawab error" dari "server tidak menjawab sama sekali". Versi
    // lama membuang res.err, jadi timeout dan 403 sama-sama muncul sebagai {ok:false}
    if (res.err) return { ok: false, error: "tidak ada respons dari bot.py (" + res.err + ")" };
    try { return JSON.parse(res.body); }
    catch (e) {
      return {
        ok: false,
        error: "respons bot.py bukan JSON: " + String(res.body || "").slice(0, 120),
      };
    }
  }

  // reqGM tidak pernah reject -- ia selalu resolve dengan {body, err}, apa pun yang terjadi
  // (404, DNS gagal, timeout). Versi lama membuang respons itu apa adanya, sehingga laporan
  async function laporGagal(payload) {
    sentuhAktivitas();
    var url = SERVER_BOT + "/selesai?secret=" + encodeURIComponent(AGENT_SECRET);
    var isi = JSON.stringify(payload);
    for (var coba = 1; coba <= 3; coba++) {
      var res = await reqGM({
        method: "POST",
        url: url,
        data: isi,
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      });
      if (!res.err) {
        try {
          if (JSON.parse(res.body || "{}").ok) return true;
        } catch (e) {
          // Respons non-JSON tanpa error: anggap sudah sampai (server tetap jadi acuan).
          if (res.body) return true;
        }
      }
      log("laporGagal percobaan " + coba + "/3 belum berhasil" +
        (res.err ? " (" + res.err + ")" : "") + ".");
      if (coba < 3) await wait(1500 * coba);
    }
    return false;
  }

  // Lapor kegagalan ke bot lalu bersihkan state -- TAPI hanya kalau laporannya benar-benar
  // sampai. Kalau laporan gagal (jaringan berfluktuasi), state sengaja disimpan dan ditandai
  async function gagalkan(st, pesan) {
    var potong = String(pesan).slice(0, 200);
    var ok = await laporGagal({
      id: st.id, status: "gagal", pesan: potong,
      chat_id: st.chat_id, message_id: st.message_id,
      nomor: st.nomor, jenis: st.jenis,
    });
    if (ok) {
      hapusState();
      return true;
    }
    st.lapor_pending = {
      pesan: potong,
      coba: ((st.lapor_pending && st.lapor_pending.coba) || 0) + 1,
    };
    simpanState(st);
    setStatus("🔴 Gagal " + st.nomor + " · laporan belum sampai ke bot, akan dicoba lagi");
    log("Laporan kegagalan " + st.nomor + " gagal terkirim (percobaan " +
      st.lapor_pending.coba + "). State disimpan agar laporan dicoba ulang.");
    return false;
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
  var statusEl = null, toggleBtn = null, logBtn = null;
  // Pesan status ditahan sebentar sebelum kembali ke "idle". Versi lama memanggil
  // updateTampilanAuto() dari blok finally setiap task, dan fungsi itu langsung menimpa
  var STATUS_TAHAN_MS = 5000;
  var jedaResetStatus = null;

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

  function tulisStatus(teks) {
    if (statusEl) statusEl.textContent = teks;
  }

  function setStatus(teks) {
    tulisStatus(teks);
    if (jedaResetStatus) { clearTimeout(jedaResetStatus); jedaResetStatus = null; }
    jedaResetStatus = setTimeout(function () {
      jedaResetStatus = null;
      // Masih ada proses jalan: jangan tulis "idle" di atasnya, coba lagi nanti.
      if (lagiProses) { setStatusAktifTerakhir(); return; }
      if (!autoAktif) { tulisStatus("⏸ GetEmbassy: mati"); return; }
      tulisStatus("🟢 GetEmbassy: idle");
    }, STATUS_TAHAN_MS);
  }

  // Dipakai timeout saat masih ada proses berjalan: jadwalkan ulang tanpa mengubah teks.
  function setStatusAktifTerakhir() {
    jedaResetStatus = setTimeout(function () {
      jedaResetStatus = null;
      if (lagiProses) { setStatusAktifTerakhir(); return; }
      if (!autoAktif) { tulisStatus("⏸ GetEmbassy: mati"); return; }
      tulisStatus("🟢 GetEmbassy: idle");
    }, STATUS_TAHAN_MS);
  }

  // Tombol "📋": salin seluruh log yang bertahan melewati reload, supaya tidak perlu
  // DevTools sama sekali (DevTools ikut ke-clear tiap Gladius me-refresh).
  function salinLog() {
    var teks = "[GetEmbassy] log " + new Date().toLocaleString("id-ID") + "\n" +
      "URL: " + location.pathname + "\n" + ambilLog();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(teks).then(function () {
        setStatus("📋 Log dicopy (" + teks.length + " karakter)");
      }).catch(function () { tampilkanLogJendela(teks); });
    } else {
      tampilkanLogJendela(teks);
    }
  }

  // Cadangan kalau Clipboard API ditolak (konteks tidak aman / izin ditolak): tampilkan
  // log di textarea yang bisa dicari dan dicopy manual.
  function tampilkanLogJendela(teks) {
    try {
      var lama = document.getElementById("getembassy-logbox");
      if (lama) lama.remove();
      var ta = document.createElement("textarea");
      ta.id = "getembassy-logbox";
      ta.value = teks;
      ta.style.cssText =
        "position:fixed;left:16px;top:16px;width:72vw;height:70vh;z-index:1000000;" +
        "font-family:Consolas,monospace;font-size:11px;padding:8px;background:#fff;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      setStatus("📋 Log ditampilkan (clipboard ditolak)");
    } catch (e) {
      setStatus("🔴 Gagal tampilkan log: " + e);
    }
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

    logBtn = document.createElement("button");
    logBtn.id = "getembassy-log";
    logBtn.style.cssText =
      "border:none;cursor:pointer;border-radius:16px;padding:6px 12px;font-size:12px;" +
      "font-weight:700;color:#fff;background:#1565c0;box-shadow:0 2px 8px rgba(0,0,0,.25);";
    logBtn.addEventListener("click", salinLog);
    wadah.appendChild(logBtn);

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
    if (!autoAktif) {
      if (jedaResetStatus) { clearTimeout(jedaResetStatus); jedaResetStatus = null; }
      tulisStatus("⏸ GetEmbassy: mati");
      return;
    }
    // Sedang proses, atau ada pesan yang masih ditahan: jangan ganggu. Timeout yang
    // dijadwalkan setStatus() yang akan mengembalikan tampilan ke "idle" nanti.
    if (lagiProses || jedaResetStatus) return;
    tulisStatus("🟢 GetEmbassy: idle");
  }

  // ===================== WATCHDOG KEMAJUAN =====================

  // Kalau ada state tapi TIDAK BERUBAH sama sekali selama banyak siklus, prosesnya
  // macet — bukan sekadar lambat. Keadaan ini dulu tidak terlihat dari luar: loop tetap
  var SIKLUS_MACET = 12; // ~60 dtk pada POLL_INTERVAL_DETIK = 5
  var _sidikMacet = null;
  var _siklusMacet = 0;

  function sidikState(st) {
    if (!st) return "(tidak ada state)";
    return [st.id, st.step, st.attempts, st.resume, st.nav, st.reload_ours,
      st.paket_ok, st.lfu_ok, st.cek_clicked, st.password_clicked].join("|");
  }

  async function periksaMacet(st) {
    if (!st) {
      _siklusMacet = 0;
      _sidikMacet = null;
      return;
    }
    var sidik = sidikState(st);
    if (sidik !== _sidikMacet) {
      _sidikMacet = sidik;
      _siklusMacet = 0;
      return;
    }
    _siklusMacet++;
    if (_siklusMacet < SIKLUS_MACET) return;
    var detik = Math.round(_siklusMacet * POLL_INTERVAL_DETIK);
    if (_siklusMacet === SIKLUS_MACET) {
      log("⚠️ MACET terdeteksi: state " + st.id + " tidak berubah selama " +
        _siklusMacet + " siklus (~" + detik + " dtk), step '" + st.step +
        "'. Halaman sekarang " + pathSekarang() + ", target " + pathTarget(st.jenis) +
        ". Beri 2 siklus lagi sebelum menyerah.");
    }
    if (_siklusMacet <= SIKLUS_MACET + 2) return;
    _siklusMacet = 0;
    _sidikMacet = null;
    log("Menyerah: state " + st.id + " macet di step '" + st.step + "' (" + detik + " dtk tanpa perubahan).");
    await gagalkan(st, "Proses macet: halaman Gladius tidak berubah selama " + detik +
      " detik pada langkah '" + st.step + "'. Cek manual atau login ulang.");
  }

  // ===================== LOOP UTAMA =====================

  async function prosesSatu(task) {
    if (!autoAktif) return false;
    if (sudahHandled(task.id, task.nomor)) return false;
    var stateAda = bacaState();
    if (stateAda) {
      if (sudahHandled(stateAda.id, stateAda.nomor)) {
        hapusState();
      } else if (stateAda.id === task.id) {
        // State milik task yang SAMA → ini kelanjutan, bukan tabrakan. Versi lama
        // `return false` apa pun keadaannya, sehingga ketika halaman sedang salah
        log("State milik task ini juga ada (step " + stateAda.step + "), lanjut dari checkpoint.");
      } else {
        // State milik task LAIN: jangan mulai task baru di atasnya, tapi jangan juga
        // keluar tanpa jejak.
        log("Menunda task " + task.id + ": masih ada state task " + stateAda.id +
          " (step " + stateAda.step + ").");
        return false;
      }
    }
    var jenis = task.jenis === "password" ? "password" : "embassy";
    var perluNavigasi = false;
    // Dialog dari task sebelumnya tidak boleh ikut terbawa (lihat resetDialog).
    resetDialog(task.nomor);
    idAktif = task.id;
    lagiProses = true;
    log("Proses antrian " + task.id + " jenis " + jenis + " nomor " + task.nomor);
    sentuhAktivitas();
    // st dinaikkan ke luar try supaya catch tetap bisa melapor kegagalan dan menyelesaikan
    // state walau error terjadi sebelum objek state selesai dibuat.
    var st = null;
    try {
      st = {
        id: task.id, nomor: task.nomor, jenis: jenis,
        chat_id: task.chat_id, message_id: task.message_id,
        step: jenis === "password" ? "password_cek" : "cek",
        attempts: 0, resume: 0, nav: 0, reload_ours: 0, coba: [], paket_ok: false, lfu_ok: false,
        lfu_clicked: false, lfu_attempts: 0, domain: null, status: "", password_clicked: false,
        cek_clicked: false,
      };
      simpanState(st);

      setStatus("⚙️ Proses " + task.nomor + " ...");
      var navigasi = await bukaHalaman(jenis);
      if (navigasi !== "ready") {
        perluNavigasi = true;
        return true;
      }
      // Sesi bisa saja habis TEPAT saat navigasi (Gladius lempar ke login). Jangan
      // lanjut mengisi form: lapor saja, lalu tunggu login ulang.
      if (sesiTdkValid()) {
        await stopkarenaSesiHabis(st);
        return false;
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
        st.cek_clicked = true;
        simpanState(st);
        await tungguTenang(WAIT_HASIL_MS, basisCek);
        await lanjutDariCek(bacaState() || st);
      }
    } catch (err) {
      setStatus("🔴 Gagal proses " + task.nomor);
      log("Gagal: " + err);
      await gagalkan(
        st || {
          id: task.id, chat_id: task.chat_id, message_id: task.message_id,
          nomor: task.nomor, jenis: jenis,
        },
        String(err)
      );
    } finally {
      lagiProses = false;
      idAktif = null;
      updateTampilanAuto();
    }
    return perluNavigasi;
  }

  // Reload penjaga: menembak HANYA bila tab sunyi total selama SESI_SUNYI_MS dan tidak
  // ada pekerjaan berjalan. Poll /antrian tiap 5 dtk tidak dihitung sebagai aktivitas,
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

  async function loopSiklus() {    while (autoAktif) {
      try {
        // Cek sesi PALING AWAL, sebelum apa pun. Selama sesi habis, semua task akan
        // gagal dengan sebab yang sama, jadi jangan mulai satu pun.
        if (sesiTdkValid()) {
          await stopkarenaSesiHabis(bacaState());
          await tidur(SESI_HABIS_TUNGGU_MS);
          continue;
        }
        // Sesi sudah kembali (kamu baru saja login). Reset penandanya supaya bot
        // lanjut 정상 dari antrian.
        if (SESI_HABIS_ATAS) {
          SESI_HABIS_ATAS = false;
          setStatus("🟢 Sesi Gladius kembali — lanjut antrian");
          log("Sesi Gladius kembali normal, lanjut proses antrian.");
        }
        await jagaSesi();
        var items = await ambilAntrian();
        var stateAntrian = bacaState();
        if (stateAntrian && !sudahHandled(stateAntrian.id, stateAntrian.nomor)) {
          var masihPending = false;
          for (var si = 0; si < items.length; si++) {
            if (items[si].id === stateAntrian.id) { masihPending = true; break; }
          }
          if (!masihPending) hapusState();
        }
        var stateLanjut = bacaState();
        if (stateLanjut && !sudahHandled(stateLanjut.id, stateLanjut.nomor) && !idAktif) {
          // Syarat diHalamanTarget() DIHAPUS di sini. Pempulih lanjutan
          // (cobaResumeSetelahReload) sudah memanggil bukaHalaman() sendiri, jadi aman
          await cobaResumeSetelahReload();
          // Watchdog harus jalan SETELAH resume juga, bukan hanya di jalur tanpa state.
          // Versi lama menaruh periksaMacet() sesudah blok ini yang selalu `continue`,
          await periksaMacet(bacaState());
          // Jangan biarkan resume mengunci loop penuh (continue di atas melompati
          // tidur(POLL_INTERVAL_DETIK) di bawah). Bila resume gagal berkemajuan dan
          await tidur(1500);
          continue;
        }
        await periksaMacet(bacaState());
        for (var i = 0; i < items.length; i++) {
          if (!autoAktif) break;
          var it = items[i];
          if (sudahHandled(it.id, it.nomor)) continue;
          if (idAktif && it.id === idAktif) continue;
          var stateSekarang = bacaState();
          if (stateSekarang && !sudahHandled(stateSekarang.id, stateSekarang.nomor) &&
              stateSekarang.id !== it.id) continue;
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