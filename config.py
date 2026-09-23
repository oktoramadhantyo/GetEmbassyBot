# -*- coding: utf-8 -*-
"""Konfigurasi pusat GetEmbassy (dibaca dari .env dengan fallback default)."""

import os
import pathlib

from dotenv import load_dotenv

load_dotenv()

BASE = pathlib.Path(__file__).resolve().parent

# ==================== KONFIGURASI BOT ====================
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
if not TOKEN:
    raise SystemExit(
        "TELEGRAM_BOT_TOKEN belum di-set. "
        "Buat file .env dari .env.example lalu isi token, "
        "atau set environment variable TELEGRAM_BOT_TOKEN."
    )

# ==================== SELENIUM / BROWSER ====================
# Port Chrome remote debugging (Chrome dijalankan dengan flag:
#   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
# )
DEBUG_PORT = int(os.getenv("DEBUG_PORT", "9222"))

# URL halaman embassy Web Gladius
GLADIUS_URL = os.getenv(
    "GLADIUS_URL",
    "https://gladius.telkom.co.id/radonline/newradonline",
)

# Timeout (detik) menunggu hasil pengukuran / Last Five Usage selesai dimuat
WAIT_HASIL = int(os.getenv("WAIT_HASIL", "30"))
WAIT_LFU = int(os.getenv("WAIT_LFU", "30"))

# ==================== OUTPUT ====================
SCREENSHOT_DIR = pathlib.Path(os.getenv("SCREENSHOT_DIR", "outputs"))

# ==================== TEKS TOMBOL (REFERENSI) ====================
# Nama tombol dicari toleran berdasarkan teks; disimpan terpusat biar mudah
# disesuaikan saat validasi di halaman nyata.
TEKS_TOMBOL_CEK = "Cek Kualitas Jaringan"
TEKS_TOMBOL_LFU = "Last Five Usage"