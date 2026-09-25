// ==UserScript==
// @name         GetEmbassy Gladius - Proses Otomatis
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  [GetEmbassy] Auto-proses antrian /embassy dan /password dari bot Railway langsung di halaman Gladius: isi Nomor Internet, proses Embassy atau Password Check, ambil screenshot (html2canvas), lalu kirim base64 ke Railway. Tanpa Python/Selenium/debug port.
// @author       diana
// @match        https://gladius.telkom.co.id/*
// @grant        GM_xmlhttpRequest
// @connect      getembassybot-production.up.railway.app
// @require      https://html2canvas.hertzen.com/dist/html2canvas.min.js
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // ===================== KONFIGURASI (edit sesuai .env / Railway) =====================
  var RAILWAY_URL = "https://getembassybot-production.up.railway.app";
  var AGENT_SECRET = "njcdB4gEitPWyMSFVc58s388";
  var POLL_INTERVAL_DETIK = 10; // jeda polling antrian
  var WAIT_HASIL_MS = 15000; // tunggu hasil "Cek Kualitas Jaringan" stabil
  var WAIT_LFU_MS = 15000; // tunggu "Last Five Usage" selesai dimuat
  var SS_SCALE = 1; // skala screenshot (lebih kecil = file ringan, hasil ± lebar area crop)
  var SS_CROP = "auto"; // "auto" = area hasil ukur (sidebar+logo+tabel hasil+LFU) | "none" = full page
  var SS_CROP_PAD = 16; // ruang ekstra di sekeliling area hasil (px)
  var SS_CROP_OVERRIDE = null; // kalau auto meleset: isi {left, top, right, bottom}
  var SS_MASK_PASSWORD = true;

  var DAFTAR_DOMAIN = ["apps.telkom", "telkom.net", "gold.telkom", "telkom.b2b"];
  var NILAI_PAKET_KOSONG = ["/", "-", "", "0", "n/a", "na", "kosong", "null", "none"];
  var TEKS_KOLOM_PAKET = "paket radius";
  var TEKS_KOLOM_PAKET_ALT = "paket pcrf";
  var TEKS_TOMBOL_CEK = "Cek Kualitas Jaringan";
  var TEKS_TOMBOL_LFU = "Last Five Usage";
  var TEKS_TOMBOL_PASSWORD = "Check";
  var URL_EMBASSY = "https://gladius.telkom.co.id/radonline/newradonline";
  var URL_PASSWORD = "https://gladius.telkom.co.id/internetnumberr/passwordchecknew";
  var MENU_EMBASSY = ["Embassy", "Pengukuran via Rest API"];
  var MENU_PASSWORD = ["Internet Number Check", "Password Check"];
  var NAV_TIMEOUT_MS = 10000;
  var WAIT_PASSWORD_MS = 15000;
  // ====================================================================================

  // ===================== STATE TOLERAN RELOAD (sessionStorage) =====================
  // Halaman Gladius me-reload tiap klik Cek/LFU dan auto-refresh periodik. State di
  // sessionStorage disimpan SEBELUM tiap langkah berisiko-reload; begitu script
  // terbangun kembali sesudah reload, ia MELANJUTKAN dari langkah terakhir,
  // bukan mengulang dari nol (mencegah loop klik->reload).
  var STATE_KEY = "getembassy_state";
  var HANDLED_KEY = "getembassy_handled";
  var MAX_ATTEMPTS = 6; // batas percobaan/reload per task
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

  function cariInput() {
    var inputs = document.querySelectorAll("input, textarea");
    var best = null, bestSkor = -1;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.offsetParent === null) continue;
      var ty = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "checkbox", "radio", "file", "image"].indexOf(ty) >= 0) continue;
      if (el.disabled) continue;
      var skor = 10;
      var ph = (el.placeholder || "").toLowerCase();
      var nm = ((el.name || "") + " " + (el.id || "")).toLowerCase();
      if (/nomor|internet|no\.? ?\d|telp/.test(ph) || /nomor|internet/.test(nm)) skor += 50;
      else if (/search|cari|query/.test(ph)) skor += 20;
      if (best === null || skor > bestSkor) { bestSkor = skor; best = el; }
    }
    return best;
  }

  function isiNomor(nomor) {
    var el = cariInput();
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    try { el.focus(); } catch (e) {}
    try { el.click(); } catch (e) {}
    try {
      var proto = (el.tagName === "TEXTAREA") ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, nomor);
      else el.value = nomor;
    } catch (e) {
      el.value = nomor;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
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

  function bacaPaket() {
    function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    var kw = TEKS_KOLOM_PAKET, alt = TEKS_KOLOM_PAKET_ALT;
    var pat = new RegExp("(?:" + esc(kw) + "|" + esc(alt) + ")", "i");
    var seen = {};
    var cells = document.querySelectorAll("td,th,div,span,label,li");
    for (var i = 0; i < cells.length; i++) {
      var el = cells[i];
      var t = norm(el.innerText || el.textContent || "");
      if (!t) continue;
      var m = t.match(pat);
      if (!m) continue;
      var val = t.slice(m.index + m[0].length).replace(/^[\s:=\-]+/, "").trim();
      var row = el.closest("tr");
      if (row) {
        var cs = row.querySelectorAll("td,th");
        for (var k2 = 0; k2 < cs.length; k2++) {
          if (cs[k2] === el && k2 + 1 < cs.length) {
            var v2 = norm(cs[k2 + 1].innerText || cs[k2 + 1].textContent || "");
            if (v2 && v2.length <= 60 && !seen[v2]) { seen[v2] = 1; return v2; }
          }
        }
      }
      var par = el.parentElement;
      if (par && par !== el) {
        var pt = norm(par.innerText || par.textContent || "");
        if (pt.length > t.length) {
          var pm = pt.match(pat);
          if (pm) {
            var pv = pt.slice(pm.index + pm[0].length).replace(/^[\s:=\-]+/, "").trim();
            if (pv && pv.length <= 60 && !seen[pv]) { seen[pv] = 1; return pv; }
          }
        }
      }
      if (val && val.length <= 60 && !seen[val]) { seen[val] = 1; return val; }
    }
    return "";
  }

  function paketKosong(nilai) {
    nilai = String(nilai || "").trim().toLowerCase();
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

  // Area "hasil ukur" untuk screenshot: tabel hasil Embassy ("paket radius/pcrf")
  // + panel "Last Five Usage", ditambah sidebar/logo Gladius di kiri atas.
  function cariKotakHasil() {
    function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    var kw = TEKS_KOLOM_PAKET, alt = TEKS_KOLOM_PAKET_ALT;
    var pat = new RegExp("(?:" + esc(kw) + "|" + esc(alt) + ")", "i");
    var patLfu = new RegExp(esc(TEKS_TOMBOL_LFU), "i");
    var box = null;
    var semua = document.querySelectorAll("td,th,tr,div,span,label,table");
    for (var i = 0; i < semua.length; i++) {
      var el = semua[i];
      var t = norm(el.innerText || el.textContent || "");
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

  function tungguTenang(kapurMs) {
    return new Promise(function (resolve) {
      var akhir = Date.now() + kapurMs;
      var prev = -1, stabil = 0;
      (function cek() {
        var len = document.body ? (document.body.innerText || "").length : 0;
        if (len === prev) stabil++; else stabil = 0;
        prev = len;
        if (stabil >= 2 || Date.now() >= akhir) { resolve(stabil >= 2); return; }
        setTimeout(cek, 500);
      })();
    });
  }

  function teksEl(el) {
    return String((el && (el.innerText || el.textContent || el.value)) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cariMenu(teks) {
    teks = String(teks || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!teks) return null;
    var root = document.querySelector("#sidebar, .sidebar-wrapper, aside");
    var scope = root ? [root] : [document];
    var best = null;
    var bestSkor = -1;
    for (var s = 0; s < scope.length; s++) {
      var els = scope[s].querySelectorAll("a, button, li, span, div");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        var t = teksEl(el).toLowerCase();
        if (t !== teks && t.indexOf(teks) < 0) continue;
        if (t.length > teks.length * 4) continue;
        var skor = 0;
        var tag = el.tagName.toLowerCase();
        if (tag === "a" || tag === "button") skor += 100;
        if (tag === "li") skor += 40;
        if (t === teks) skor += 50;
        if (teksEl(el).length <= 60) skor += 10;
        if (skor > bestSkor) { bestSkor = skor; best = el; }
      }
      if (best) return best;
    }
    return cariTeks(teks, true);
  }

  function tungguMenu(teks, maxMs) {
    return new Promise(function (resolve) {
      var mulai = Date.now();
      (function poll() {
        var el = cariMenu(teks);
        if (el) { resolve(el); return; }
        if (Date.now() - mulai >= (maxMs || 5000)) {
          resolve(null);
          return;
        }
        setTimeout(poll, 200);
      })();
    });
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

  function tungguPath(jenis, maxMs) {
    return new Promise(function (resolve) {
      var mulai = Date.now();
      (function poll() {
        if (diHalamanTarget(jenis)) { resolve(true); return; }
        if (Date.now() - mulai >= (maxMs || NAV_TIMEOUT_MS)) {
          resolve(false);
          return;
        }
        setTimeout(poll, 200);
      })();
    });
  }

  async function bukaHalaman(jenis) {
    if (diHalamanTarget(jenis)) return "ready";
    var labels = jenis === "password" ? MENU_PASSWORD : MENU_EMBASSY;
    setStatus("🔎 Membuka halaman " + (jenis === "password" ? "Password Check" : "Embassy") + " ...");
    var parent = await tungguMenu(labels[0], 3000);
    if (parent) {
      try { parent.click(); } catch (e) {}
      await tungguTenang(500);
    }
    var child = await tungguMenu(labels[1], 5000);
    if (child) {
      try { child.click(); } catch (e) {}
      await tungguPath(jenis, 5000);
    }
    if (diHalamanTarget(jenis)) return "ready";
    try { location.assign(targetURL(jenis)); } catch (e) {}
    return "navigating";
  }

  async function tungguFormTugas(jenis) {
    var mulai = Date.now();
    var maks = jenis === "password" ? WAIT_PASSWORD_MS : WAIT_HASIL_MS;
    while (Date.now() - mulai < maks) {
      var input = cariInput();
      var tombol = jenis === "password"
        ? (cariTeks(TEKS_TOMBOL_PASSWORD, true) || cariTeks("Cek", true))
        : cariTeks(TEKS_TOMBOL_CEK, true);
      if (input && tombol) return true;
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
    maxMs = maxMs || 12000;
    return new Promise(function (resolve) {
      var mulai = Date.now();
      (function poll() {
        var v = bacaPaket();
        if (!paketKosong(v) || Date.now() - mulai >= maxMs) {
          resolve(v);
          return;
        }
        setTimeout(poll, 1000);
      })();
    });
  }

  // Setelah tombol "Cek" ditekan (inline ATAU resume pasca-reload): baca hasilnya.
  async function lanjutDariCek(st) {
    var paket = await tungguHasilPaket(12000);
    if (!paketKosong(paket)) {
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
      await tungguTenang(WAIT_HASIL_MS);
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

  function bacaStatusPassword() {
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
            if (statusValue) return statusValue.slice(0, 200);
          }
        }
      }
    }
    var el = cariElemenStatusPassword();
    if (!el) return "Status tidak ditemukan";
    var row = el.closest("tr");
    if (row) {
      var cells = row.querySelectorAll("td, th");
      for (var i = 0; i < cells.length; i++) {
        if (cells[i] === el && i + 1 < cells.length) {
          var value = teksEl(cells[i + 1]);
          if (value) return value.slice(0, 200);
        }
      }
    }
    var sibling = el.nextElementSibling;
    if (sibling) {
      var siblingText = teksEl(sibling);
      if (siblingText && siblingText.length <= 200) return siblingText;
    }
    var text = teksEl(el);
    var match = text.match(/status(?:\s+(?:password|pelanggan))?\s*[:\-]\s*(.+)$/i);
    if (match && match[1]) return match[1].trim().slice(0, 200);
    return "Status tidak terbaca";
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
    if (st.step === "password_cek") {
      setStatus("⚙️ Password check " + st.nomor + " ...");
      if (!isiNomor(st.nomor)) throw new Error("Kolom input Nomor Internet tidak ditemukan.");
      st.step = "password_hasil";
      st.password_clicked = true;
      simpanState(st);
      if (!klikTeks(TEKS_TOMBOL_PASSWORD, true)) {
        throw new Error("Tombol '" + TEKS_TOMBOL_PASSWORD + "' tidak ditemukan.");
      }
      await tungguTenang(WAIT_PASSWORD_MS);
    } else {
      await tungguTenang(WAIT_PASSWORD_MS);
    }
    st.status = bacaStatusPassword();
    st.step = "password_screenshot";
    simpanState(st);
    return lanjutKeScreenshot(st);
  }

  // Paket sudah berisi → klik "Last Five Usage".
  async function lanjutKeLfu(st) {
    st.step = "lfu";
    st.lfu_clicked = false;
    st.lfu_ok = false;
    simpanState(st);
    setStatus("⚙️ " + st.nomor + " · Last Five Usage...");
    if (klikTeks(TEKS_TOMBOL_LFU, true)) {
      st.lfu_clicked = true;
      simpanState(st);
      await tungguTenang(WAIT_LFU_MS);
      st.lfu_ok = true;
      simpanState(st);
      // Bila klik memicu reload → mati di sini; resume 'lfu' akan klik ulang lagi.
      return lanjutKeScreenshot(bacaState() || st);
    }
    // Tombol tidak ketemu → jangan diam-diam: tandai lfu_ok=false + warning,
    // screenshot tetap dikirim (caption nanti memuat catatan LFU gagal).
    setStatus("⚠️ " + st.nomor + " · tombol Last Five Usage tidak ditemukan");
    log("LFU tidak ditemukan untuk " + st.nomor + " (screenshot tetap dikirim).");
    return lanjutKeScreenshot(st);
  }

  async function lanjutKeScreenshot(st) {
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
      log("Gagal kirim ke Railway: " + JSON.stringify(resp));
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
    if (st.attempts >= MAX_ATTEMPTS || st.resume >= MAX_ATTEMPTS) {
      setStatus("🔴 Gagal (reload berulang) " + st.nomor);
      log("Task " + st.id + " menyerah setelah banyak reload.");
      try {
        await laporGagal({
          id: st.id, status: "gagal",
          pesan: "Proses terulang karena halaman reload berulang.",
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
      if (navigasi !== "ready") return true;
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

  function ambilSS(jenis) {
    return new Promise(function (resolve, reject) {
      if (typeof html2canvas === "undefined") {
        reject(new Error("html2canvas belum dimuat (cek @require/internet)."));
        return;
      }
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
      try { window.scrollTo(0, box.top); } catch (e) {}
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
        var dataUrl = canvas.toDataURL("image/png");
        restore();
        resolve(dataUrl.indexOf(",") >= 0 ? dataUrl.split(",")[1] : "");
      }).catch(function (err) {
        restore();
        reject(err);
      });
    });
  }

  // ===================== KOMUNIKASI DENGAN RAILWAY =====================

  function reqGM(opt) {
    return new Promise(function (resolve) {
      function selesai(body, err) { resolve({ body: body, err: err }); }
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
        var init = { method: opt.method || "GET" };
        if (opt.data) { init.body = opt.data; init.headers = opt.headers || {}; }
        fetch(opt.url, init)
          .then(function (r) { return r.text(); })
          .then(function (txt) { selesai(txt); })
          .catch(function (e) { selesai("", String(e)); });
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

  async function kirimHasil(payload) {
    var url = RAILWAY_URL + "/kirim?secret=" + encodeURIComponent(AGENT_SECRET);
    var res = await reqGM({
      method: "POST",
      url: url,
      data: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });
    try { return JSON.parse(res.body); }
    catch (e) { return { ok: false }; }
  }

  async function laporGagal(payload) {
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
  var statusEl = null, toggleBtn = null;
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
    try {
      var st = {
        id: task.id, nomor: task.nomor, jenis: jenis,
        chat_id: task.chat_id, message_id: task.message_id,
        step: jenis === "password" ? "password_cek" : "cek",
        attempts: 0, resume: 0, coba: [], paket_ok: false, lfu_ok: false,
        lfu_clicked: false, domain: null, status: "", password_clicked: false,
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
        if (!isiNomor(task.nomor)) throw new Error("Kolom input Nomor Internet tidak ditemukan.");
        if (!klikTeks(TEKS_TOMBOL_CEK, true)) throw new Error("Tombol '" + TEKS_TOMBOL_CEK + "' tidak ditemukan.");
        await tungguTenang(WAIT_HASIL_MS);
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

  async function loopSiklus() {
    while (autoAktif) {
      try {
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