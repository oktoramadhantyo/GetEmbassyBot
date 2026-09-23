# -*- coding: utf-8 -*-
"""Logika cek embassy di Web Gladius.

Alur:
  1. Buka halaman embassy (GLADIUS_URL).
  2. Isi kolom Nomor Internet dengan nomor dari user.
  3. Klik "Cek Kualitas Jaringan".
  4. Tunggu hasil.
  5. Klik "Last Five Usage", tunggu isinya selesai dimuat.
  6. Ambil SATU screenshot full-page berisi hasil + riwayat.

Catatan selector: halaman tidak punya selector resmi yang terdokumentasi, jadi
elemen dicari toleran via teks (pola BotInsera). Divalidasi saat test langsung.
"""

import sys
import time
from datetime import datetime

from selenium.webdriver.remote.webdriver import WebDriver

from config import GLADIUS_URL, WAIT_HASIL, WAIT_LFU, SCREENSHOT_DIR, TEKS_TOMBOL_CEK, TEKS_TOMBOL_LFU
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
        driver.execute_script("arguments[0].scrollIntoView(true);", el)
        time.sleep(0.3)
        el.click()
        return True
    except Exception:
        # Fallback: klik via JS
        try:
            driver.execute_script(
                "arguments[0].scrollIntoView(true); arguments[0].click();", el
            )
            return True
        except Exception:
            return False


def _isi_nomor(driver: WebDriver, nomor: str) -> bool:
    el = driver.execute_script(_JS_CARI_INPUT)
    if el is None:
        return False
    driver.execute_script("arguments[0].scrollIntoView(true);", el)
    el.click()
    el.clear()
    el.send_keys(nomor)
    return True


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
      nomor, waktu, screenshot (Path), hasil_ok (bool), lfu_ok (bool)
    """
    import pathlib

    hasil = {
        "nomor": nomor,
        "waktu": _waktu_str(),
        "screenshot": None,
        "hasil_ok": False,
        "lfu_ok": False,
    }

    _buka_tab_gladius(driver)
    _tunggu_tenang(driver, min(WAIT_HASIL, 8))

    if not _isi_nomor(driver, nomor):
        raise LookupError("Kolom input Nomor Internet tidak ditemukan di halaman embassy.")

    if not _klik_teks(driver, TEKS_TOMBOL_CEK, needs_include=True):
        raise LookupError(f"Tombol '{TEKS_TOMBOL_CEK}' tidak ditemukan.")

    # Tunggu hasil muncul (page settle)
    _tunggu_tenang(driver, WAIT_HASIL)
    hasil["hasil_ok"] = _cari_teks(driver, TEKS_TOMBOL_LFU, needs_include=True) is not None

    if hasil["hasil_ok"]:
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
        print(f"hasil_ok={hasil['hasil_ok']} lfu_ok={hasil['lfu_ok']}")
    finally:
        browser.tutup(driver)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main_cli())