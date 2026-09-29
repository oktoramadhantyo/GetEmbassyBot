# -*- coding: utf-8 -*-
"""Attach ke sesi Chrome yang sudah login Gladius via remote debugging port.

Prinsip (pola BotInsera): TIDAK membuka browser baru dan TIDAK melakukan login.
Hanya menyambung (attach) ke Chrome yang sedang berjalan dengan flag
`--remote-debugging-port=<DEBUG_PORT>`.
"""

import socket

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

from config import DEBUG_PORT


def cek_debug_port_terbuka(port: int = DEBUG_PORT) -> bool:
    """Cek apakah ada Chrome dengan remote debugging port aktif."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


def buat_driver(port: int = DEBUG_PORT) -> webdriver.Chrome:
    """Menyambung ke Chrome existing yang aktif pada port debugging.

    Mengharuskan Chrome dijalankan dengan:
        chrome.exe --remote-debugging-port=<port> --user-data-dir="<folder-profil>"
    """
    options = Options()
    options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
    return webdriver.Chrome(options=options)


def tutup(driver: webdriver.Chrome) -> None:
    """Menutup koneksi ke browser (tanpa menutup Chrome karena itu milik user)."""
    try:
        driver.quit()
    except Exception:
        pass