# -*- coding: utf-8 -*-
"""Logika cek embassy di Web Gladius.

Alur:
  1. Buka halaman embassy (GLADIUS_URL).
  2. Isi kolom Nomor Internet dengan nomor dari user.
  3. Klik "Cek Kualitas Jaringan".
  4. Baca kolom Paket Radius / Paket PCRF:
     - sudah berisi -> lanjut ke langkah 6.
     - kosong (mis. "/") -> ganti dropdown domain ke DAFTAR_DOMAIN
       (apps.telkom, telkom.net, gold.telkom, telkom.b2b), klik "Cek" lagi,
       ulangi sampai kolom paket berisi atau semua domain sudah dicoba.
  5. Jika SEMUA domain kosong -> skip Last Five, tetap foto hasil.
  6. Jika paket berisi -> klik "Last Five Usage", tunggu isinya selesai dimuat.
  7. Ambil SATU screenshot full-page berisi hasil + riwayat.

Catatan selector: halaman tidak punya selector resmi yang terdokumentasi, jadi
elemen dicari toleran via teks (pola BotInsera). Divalidasi saat test langsung.
"""

import sys
import time
from datetime import datetime

from selenium.webdriver.remote.webdriver import WebDriver

from config import (
    GLADIUS_URL,
    WAIT_HASIL,
    WAIT_LFU,
    SCREENSHOT_DIR,
    TEKS_TOMBOL_CEK,
    TEKS_TOMBOL_LFU,
    DAFTAR_DOMAIN,
    NILAI_PAKET_KOSONG,
    TEKS_KOLOM_PAKET,
    TEKS_KOLOM_PAKET_ALT,
)
from scraper import browser

_JS_CARI_TEKS = r"""
function __cariTeks(teks, needsInclude){
  teks = String(teks).toLowerCase().trim().replace(/\s+/g,' ');
  if(!teks) return null;
  var tags = ['button','a','input','span','li','div','td'];
  var els = document.querySelectorAll(tags.join(','));
  var best = null, bestSkor = -1;
  for(var i=0;i<els.length;i++){
    var el = els[i];
    if(el.offsetParent === null) continue;
    var t = ((el.innerText||'') + ' ' + (el.value||'')).replace(/\s+/g,' ').trim().toLowerCase();
    if(!t) continue;
    var exact = (t === teks);
    var inc = t.indexOf(teks) >= 0;
    if(!exact && !inc) continue;
    if(exact && t.length > teks.length * 2) continue;
    if(!exact && t.length > teks.length * (needsInclude ? 12 : 3)) continue;
    var skor = 0;
    var tag = el.tagName.toLowerCase();
    if(tag==='button'||tag==='a'||tag==='input') skor += 100;
    if(exact) skor += 50;
    else skor += 20 - Math.min(20, t.length - teks.length);
    if(el.innerText && el.innerText.trim().length <= 40) skor += 10;
    if(skor > bestSkor){ bestSkor = skor; best = el; }
  }
  return best;
}
return __cariTeks(arguments[0], arguments[1]);
"""

_JS_CARI_INPUT = r"""
function __cariInput(){
  var inputs = document.querySelectorAll('input, textarea');
  var best = null, bestSkor = -1;
  for(var i=0;i<inputs.length;i++){
    var el = inputs[i];
    if(el.offsetParent === null) continue;
    var ty = (el.type||'').toLowerCase();
    if(['hidden','submit','button','reset','checkbox','radio','file','image'].indexOf(ty) >= 0) continue;
    if(el.disabled) continue;
    var skor = 10;
    var ph = (el.placeholder||'').toLowerCase();
    var nm = ((el.name||'')+' '+(el.id||'')).toLowerCase();
    if(/nomor|internet|no\.? ?\d|telp/.test(ph) || /nomor|internet/.test(nm)) skor += 50;
    else if(/search|cari|query/.test(ph)) skor += 20;
    if(best === null || skor > bestSkor){ bestSkor = skor; best = el; }
  }
  return best;
}
return __cariInput();
"""

# Pilih opsi pada dropdown domain. Hanya mempertimbangkan <select> yang punya
# opsi bertanda titik (heuristik: dropdown domain sendirian, bukan dropdown lain)
# agar tidak menyentuh <select> tidak terkait (mis. paginasi).
_JS_PILIH_DOMAIN = r"""
function __pilihDomain(domain){
  domain = String(domain).toLowerCase().trim();
  var pat = /\./;
  var sel = document.querySelectorAll('select');
  for(var i=0;i<sel.length;i++){
    var s = sel[i];
    var ada = false;
    for(var j=0;j<s.options.length;j++){
      if(pat.test((s.options[j].text||'')+' '+(s.options[j].value||''))){ ada = true; break; }
    }
    if(!ada) continue;
    for(var k=0;k<s.options.length;k++){
      var o = s.options[k];
      var teks = ((o.text||'')+' '+(o.value||'')).replace(/\s+/g,' ').trim().toLowerCase();
      if(teks.indexOf(domain) >= 0){
        s.value = o.value;
        s.dispatchEvent(new Event('change',{bubbles:true}));
        s.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      }
    }
  }
  return false;
}
return __pilihDomain(arguments[0]);
"""

# Baca label dropdown domain yang sedang terpilih (untuk efisiensi: hindari
# mengecek ulang domain yang sama). Kosong jika tidak ada <select> domain.
_JS_BACA_DOMAIN_TERPILIH = r"""
function __bacaDomain(){
  var pat = /\./;
  var sel = document.querySelectorAll('select');
  for(var i=0;i<sel.length;i++){
    var s = sel[i];
    var ada = false;
    for(var j=0;j<s.options.length;j++){
      if(pat.test((s.options[j].text||'')+' '+(s.options[j].value||''))){ ada = true; break; }
    }
    if(!ada) continue;
    var so = s[s.selectedIndex];
    return so ? ((so.text||'')+' '+(so.value||'')).replace(/\s+/g,' ').trim() : '';
  }
  return '';
}
return __bacaDomain();
"""

# Baca isi kolom "Paket Radius / Paket PCRF" dari hasil. Mengembalikan teks
# mentah nilai kolom (kosong bila tidak ketemu / tidak ada nilai).
_JS_BACA_PAKET = r"""
function __bacaPaket(kw, alt){
  function norm(s){ return (s||'').replace(/\s+/g,' ').trim(); }
  var pat = new RegExp('(?:' + kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '|' + alt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')','i');
  var seen = {};
  var cells = document.querySelectorAll('td,th,div,span,label,li');
  for(var i=0;i<cells.length;i++){
    var el = cells[i];
    var t = norm(el.innerText||el.textContent||'');
    if(!t) continue;
    var m = t.match(pat);
    if(!m) continue;
    // Nilai = teks sehabis kata kunci pada elemen itu sendiri
    var val = t.slice(m.index + m[0].length).replace(/^[\s:=\-]+/,'').trim();
    // Prioritas: sel/saudara berikutnya pada baris tabel
    var row = el.closest('tr');
    if(row){
      var cs = row.querySelectorAll('td,th');
      for(var k=0;k<cs.length;k++){
        if(cs[k]===el && k+1<cs.length){
          var v2 = norm(cs[k+1].innerText||cs[k+1].textContent||'');
          if(v2 && v2.length<=60 && !seen[v2]){ seen[v2]=1; return v2; }
        }
      }
    }
    // Lalu: teks induk sehabis kata kunci
    var par = el.parentElement;
    if(par && par!==el){
      var pt = norm(par.innerText||par.textContent||'');
      if(pt.length>t.length){
        var pm = pt.match(pat);
        if(pm){
          var pv = pt.slice(pm.index+pm[0].length).replace(/^[\s:=\-]+/,'').trim();
          if(pv && pv.length<=60 && !seen[pv]){ seen[pv]=1; return pv; }
        }
      }
    }
    if(val && val.length<=60 && !seen[val]){ seen[val]=1; return val; }
  }
  return '';
}
return __bacaPaket(arguments[0], arguments[1]);
"""


def _normalisasi(teks: str) -> str:
    return " ".join(teks.split()).lower()


def _tunggu_tenang(driver: WebDriver, kapur: float) -> bool:
    """Tunggu sampai teks halaman stabil (tidak berubah) atau kapur habis."""
    akhir = time.time() + kapur
    prev = -1
    stabil = 0
    while time.time() < akhir:
        try:
            panjang = len(driver.execute_script(
                "return document.body ? document.body.innerText : ''"
            ))
        except Exception:
            break
        if panjang == prev:
            stabil += 1
            if stabil >= 2:
                return True
        else:
            stabil = 0
        prev = panjang
        time.sleep(0.5)
    return False


def _cari_teks(driver: WebDriver, teks: str, needs_include: bool = False):
    """Mencari elemen klik-able berdasarkan teks (toleran)."""
    return driver.execute_script(_JS_CARI_TEKS, teks, needs_include)


def _klik_teks(driver: WebDriver, teks: str, needs_include: bool = False) -> bool:
    el = _cari_teks(driver, teks, needs_include)
    if el is None:
        return False
    try:
        driver.execute_script(
            "arguments[0].scrollIntoView({block:'center', inline:'center'});", el
        )
        time.sleep(0.3)
        el.click()
        return True
    except Exception:
        # Fallback: klik via JS
        try:
            driver.execute_script(
                "arguments[0].scrollIntoView({block:'center', inline:'center'}); "
                "arguments[0].click();",
                el,
            )
            return True
        except Exception:
            return False


def _isi_nomor(driver: WebDriver, nomor: str) -> bool:
    el = driver.execute_script(_JS_CARI_INPUT)
    if el is None:
        return False
    driver.execute_script(
        "arguments[0].scrollIntoView({block:'center', inline:'center'});", el
    )
    time.sleep(0.3)
    try:
        el.click()
    except Exception:
        driver.execute_script("arguments[0].click();", el)
    el.clear()
    el.send_keys(nomor)
    return True


def _isi_dropdown(driver: WebDriver, domain: str) -> bool:
    """Set dropdown domain ke 'domain'. Pakai <select> native bila ada;
    fallback klik teks untuk dropdown custom."""
    if driver.execute_script(_JS_PILIH_DOMAIN, domain):
        time.sleep(0.4)
        return True
    return _klik_teks(driver, domain)


def _baca_domain_terpilih(driver: WebDriver) -> str:
    """Label dropdown domain yang sedang aktif (untuk efisiensi)."""
    try:
        return str(driver.execute_script(_JS_BACA_DOMAIN_TERPILIH) or "").strip()
    except Exception:
        return ""


def _baca_paket_radius(driver: WebDriver) -> str:
    """Nilai mentah kolom Paket Radius / Paket PCRF pada hasil Cek."""
    try:
        raw = driver.execute_script(_JS_BACA_PAKET, TEKS_KOLOM_PAKET, TEKS_KOLOM_PAKET_ALT)
        return " ".join(str(raw or "").split())
    except Exception:
        return ""


def _paket_kosong(nilai: str) -> bool:
    return nilai.strip().lower() in NILAI_PAKET_KOSONG


def _buka_tab_gladius(driver: WebDriver) -> bool:
    """Pakai tab Gladius yang sudah terbuka, atau buka tab baru ke GLADIUS_URL."""
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if "gladius" in driver.current_url:
            return True
    driver.execute_script("window.open(arguments[0]);", GLADIUS_URL)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if GLADIUS_URL.split("//")[1].split("/")[0] in driver.current_url:
            return True
    time.sleep(1)
    return False


def _screenshot_full(driver: WebDriver, path) -> None:
    """Screenshot full-page (capture seluruh tinggi halaman), lalu kembalikan
    ukuran jendela seperti semula agar tidak mengganggu user."""
    lama = driver.get_window_size()
    try:
        tinggi = driver.execute_script(
            "return Math.max(document.body.scrollHeight, "
            "document.documentElement.scrollHeight, window.innerHeight);"
        )
        lebar = driver.execute_script(
            "return Math.max(document.body.scrollWidth, "
            "document.documentElement.scrollWidth, window.innerWidth);"
        )
        driver.set_window_size(lebar, tinggi)
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(0.6)
        driver.save_screenshot(str(path))
    finally:
        try:
            driver.set_window_size(lama["width"], lama["height"])
        except Exception:
            pass


def _waktu_str() -> str:
    return datetime.now().strftime("%d-%m-%Y %H:%M:%S")


def cek_embassy(driver: WebDriver, nomor: str) -> dict:
    """Menjalankan satu siklus cek embassy dan menghasilkan 1 screenshot.

    Selalu mengembalikan dict dengan field:
      nomor, waktu, screenshot (Path), hasil_ok (bool), lfu_ok (bool),
      paket_ok (bool), domain_terpakai (str|None)

    Alur dropdown domain:
      - cek dulu dgn dropdown apa adanya;
      - jika kolom Paket kosong -> ganti-ganti DAFTAR_DOMAIN sambil klik "Cek"
        sampai paket berisi (atau semua domain habis dicoba);
      - Last Five Usage DIPANGGIL hanya ketika paket sudah berisi.
    """
    import pathlib

    hasil = {
        "nomor": nomor,
        "waktu": _waktu_str(),
        "screenshot": None,
        "hasil_ok": False,
        "lfu_ok": False,
        "paket_ok": False,
        "domain_terpakai": None,
    }

    _buka_tab_gladius(driver)
    _tunggu_tenang(driver, min(WAIT_HASIL, 8))

    if not _isi_nomor(driver, nomor):
        raise LookupError("Kolom input Nomor Internet tidak ditemukan di halaman embassy.")

    # 1) Cek dengan dropdown apa adanya (tanpa ganti-ganti).
    if not _klik_teks(driver, TEKS_TOMBOL_CEK, needs_include=True):
        raise LookupError(f"Tombol '{TEKS_TOMBOL_CEK}' tidak ditemukan.")
    _tunggu_tenang(driver, WAIT_HASIL)

    paket = _baca_paket_radius(driver)
    if not _paket_kosong(paket):
        hasil["paket_ok"] = True
        hasil["domain_terpakai"] = _baca_domain_terpilih(driver) or None
    else:
        # 2) Kolom kosong -> loop DAFTAR_DOMAIN sampai berisi / habis.
        dicoba = set()
        terpilih = _baca_domain_terpilih(driver).lower()
        if terpilih:
            for d in DAFTAR_DOMAIN:
                if d.lower() in terpilih:
                    dicoba.add(d.lower())
        for domain in DAFTAR_DOMAIN:
            if domain.lower() in dicoba:
                continue
            dicoba.add(domain.lower())
            if not _isi_dropdown(driver, domain):
                continue
            if not _klik_teks(driver, TEKS_TOMBOL_CEK, needs_include=True):
                continue
            _tunggu_tenang(driver, WAIT_HASIL)
            paket = _baca_paket_radius(driver)
            if not _paket_kosong(paket):
                hasil["paket_ok"] = True
                hasil["domain_terpakai"] = domain
                break

    hasil["hasil_ok"] = hasil["paket_ok"]

    # 3) Last Five Usage DIPANGGIL hanya jika kolom paket sudah berisi.
    if hasil["paket_ok"]:
        if _klik_teks(driver, TEKS_TOMBOL_LFU, needs_include=True):
            _tunggu_tenang(driver, WAIT_LFU)
            hasil["lfu_ok"] = True

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SCREENSHOT_DIR / f"embassy_{nomor}_{datetime.now():%Y%m%d_%H%M%S}.png"
    _screenshot_full(driver, path)
    hasil["screenshot"] = path
    hasil["waktu"] = _waktu_str()
    return hasil


def _main_cli() -> int:
    """Cara pakai:
      python -m scraper.embassy <nomor> [--dump]
    """
    nomor = sys.argv[1] if len(sys.argv) > 1 else None
    if not nomor:
        nomor = input("Nomor internet: ").strip()
    assert browser.cek_debug_port_terbuka(), (
        "⚠️ Port debug tidak terbuka. Jalankan Chrome dulu dengan:\n"
        '  chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug"'
    )
    driver = browser.buat_driver()
    try:
        hasil = cek_embassy(driver, nomor)
        print("HASIL:", hasil)
        if "--dump" in sys.argv:
            print("--- PAGE TEXT ---")
            print(driver.execute_script("return document.body ? document.body.innerText : ''"))
        print(f"Screenshot: {hasil['screenshot']}")
        print(
            f"hasil_ok={hasil['hasil_ok']} lfu_ok={hasil['lfu_ok']} "
            f"paket_ok={hasil['paket_ok']} domain_terpakai={hasil['domain_terpakai']}"
        )
    finally:
        browser.tutup(driver)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main_cli())