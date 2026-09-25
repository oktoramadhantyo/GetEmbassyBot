// ==UserScript==
// @name         GetEmbassy Gladius - Proses Otomatis
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  [GetEmbassy] Auto-proses antrian /embassy dari bot Railway langsung di halaman Gladius: isi Nomor Internet, Cek Kualitas Jaringan, loop dropdown domain sampai Paket Radius/PCRF berisi, Last Five Usage, screenshot (html2canvas), lalu kirim base64 ke Railway. Tanpa Python/Selenium/debug port.
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
  var POLL_INTERVAL_DETIK = 10;        // jeda polling antrian
  var WAIT_HASIL_MS = 30000;           // tunggu hasil "Cek Kualitas Jaringan" stabil
  var WAIT_LFU_MS = 30000;             // tunggu "Last Five Usage" selesai dimuat
  var SS_SCALE = 2;                    // kualitas screenshot (devicePixelRatio dibatasi)

  var DAFTAR_DOMAIN = ["apps.telkom", "telkom.net", "gold.telkom", "telkom.b2b"];
  var NILAI_PAKET_KOSONG = ["/", "-", "", "0", "n/a", "na", "kosong", "null", "none"];
  var TEKS_KOLOM_PAKET = "paket radius";
  var TEKS_KOLOM_PAKET_ALT = "paket pcrf";
  var TEKS_TOMBOL_CEK = "Cek Kualitas Jaringan";
  var TEKS_TOMBOL_LFU = "Last Five Usage";
  // ====================================================================================

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

  // ===================== PROSES 1 NOMOR (alur embassy.py) =====================

  async function cekEmbassy(nomor) {
    await tidur(600);
    var hasil = { nomor: nomor, paket_ok: false, lfu_ok: false, domain_terpakai: null, foto: "" };

    if (!isiNomor(nomor)) throw new Error("Kolom input Nomor Internet tidak ditemukan.");
    if (!klikTeks(TEKS_TOMBOL_CEK, true)) throw new Error("Tombol '" + TEKS_TOMBOL_CEK + "' tidak ditemukan.");
    await tungguTenang(WAIT_HASIL_MS);

    var paket = bacaPaket();
    if (!paketKosong(paket)) {
      hasil.paket_ok = true;
      hasil.domain_terpakai = bacaDomainTerpilih() || null;
    } else {
      var dicoba = {};
      var terpilih = (bacaDomainTerpilih() || "").toLowerCase();
      if (terpilih) {
        DAFTAR_DOMAIN.forEach(function (d) {
          if (terpilih.indexOf(d) >= 0) dicoba[d] = true;
        });
      }
      for (var i = 0; i < DAFTAR_DOMAIN.length; i++) {
        var domain = DAFTAR_DOMAIN[i];
        if (dicoba[domain]) continue;
        dicoba[domain] = true;
        setStatus("⚙️ " + nomor + " · coba domain " + domain);
        if (!pilihDomain(domain)) continue;
        if (!klikTeks(TEKS_TOMBOL_CEK, true)) continue;
        await tungguTenang(WAIT_HASIL_MS);
        paket = bacaPaket();
        if (!paketKosong(paket)) {
          hasil.paket_ok = true;
          hasil.domain_terpakai = domain;
          break;
        }
      }
    }

    if (hasil.paket_ok) {
      setStatus("⚙️ " + nomor + " · Last Five Usage...");
      if (klikTeks(TEKS_TOMBOL_LFU, true)) {
        await tungguTenang(WAIT_LFU_MS);
        hasil.lfu_ok = true;
      }
    }

    return hasil;
  }

  function ambilSS() {
    return new Promise(function (resolve, reject) {
      if (typeof html2canvas === "undefined") {
        reject(new Error("html2canvas belum dimuat (cek @require/internet)."));
        return;
      }
      var doc = document.documentElement;
      var w = Math.max(document.body.scrollWidth, doc.scrollWidth, window.innerWidth);
      var h = Math.max(document.body.scrollHeight, doc.scrollHeight, window.innerHeight);
      html2canvas(document.body, {
        useCORS: true,
        allowTaint: false,
        scale: Math.min(window.devicePixelRatio || 1, SS_SCALE),
        windowWidth: w,
        windowHeight: h,
        backgroundColor: "#ffffff",
        logging: false,
      }).then(function (canvas) {
        var dataUrl = canvas.toDataURL("image/png");
        resolve(dataUrl.indexOf(",") >= 0 ? dataUrl.split(",")[1] : "");
      }).catch(reject);
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
    toggleBtn.textContent = autoAktif ? "⏸ Auto: ON" : "▶ Auto: OFF";
    toggleBtn.style.background = autoAktif ? "#2e7d32" : "#8a8a8a";
    if (!lagiProses) {
      setStatus(autoAktif ? "🟢 GetEmbassy: idle" : "⏸ GetEmbassy: mati");
    }
  }

  // ===================== LOOP UTAMA =====================

  async function prosesSatu(task) {
    if (lagiProses || !autoAktif) return;
    lagiProses = true;
    log("Proses antrian " + task.id + " nomor " + task.nomor);
    try {
      if (!/radonline/i.test(location.href)) {
        setStatus("🔴 bukan halaman embassy (" + task.nomor + ")");
        await laporGagal({
          id: task.id, status: "gagal", pesan: "Halaman Gladius ini bukan halaman embassy.",
          chat_id: task.chat_id, message_id: task.message_id, nomor: task.nomor,
        });
        return;
      }

      setStatus("⚙️ Proses " + task.nomor + " ...");
      var hasil = await cekEmbassy(task.nomor);

      setStatus("📸 Ambil screenshot " + task.nomor + " ...");
      hasil.foto = await ambilSS();
      if (!hasil.foto) throw new Error("Screenshot kosong.");

      var payload = {
        id: task.id,
        chat_id: task.chat_id,
        message_id: task.message_id,
        nomor: hasil.nomor,
        foto: hasil.foto,
        paket_ok: !!hasil.paket_ok,
        lfu_ok: !!hasil.lfu_ok,
        domain_terpakai: hasil.domain_terpakai,
        waktu: fmtWaktu(),
      };

      setStatus("📤 Kirim hasil " + task.nomor + " ...");
      var resp = await kirimHasil(payload);
      if (resp && resp.ok && resp.sent) {
        setStatus("✅ Selesai " + task.nomor);
        log("Hasil " + task.nomor + " terkirim.");
      } else {
        setStatus("🔴 Gagal kirim foto " + task.nomor);
        log("Gagal kirim ke Railway: " + JSON.stringify(resp));
      }
    } catch (err) {
      setStatus("🔴 Gagal proses " + task.nomor);
      log("Gagal: " + err);
      try {
        await laporGagal({
          id: task.id, status: "gagal", pesan: String(err).slice(0, 200),
          chat_id: task.chat_id, message_id: task.message_id, nomor: task.nomor,
        });
      } catch (e) {}
    } finally {
      lagiProses = false;
      updateTampilanAuto();
    }
  }

  async function loopSiklus() {
    while (autoAktif) {
      try {
        var items = await ambilAntrian();
        if (items.length > 0) log("Antrian: " + items.length + " item");
        for (var i = 0; i < items.length; i++) {
          if (!autoAktif) break;
          await prosesSatu(items[i]);
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

  function pasang() {
    buatUI();
    try {
      var tersimpan = localStorage.getItem(AUTO_KEY);
      if (tersimpan !== null) autoAktif = (tersimpan === "1");
    } catch (e) {}
    updateTampilanAuto();
    if (autoAktif) mulaiLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pasang);
  } else {
    pasang();
  }
})();