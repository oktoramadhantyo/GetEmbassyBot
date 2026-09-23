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

# ==================== RELAY RAILWAY <-> AGENT LOKAL ====================
# URL publik bot di Railway (dipakai agent lokal untuk menanyakan antrian).
RAILWAY_URL = os.getenv("RAILWAY_URL", "").strip().rstrip("/")

# Kata kunci rahasia antara bot (Railway) dan agent lokal.
AGENT_SECRET = os.getenv("AGENT_SECRET", "").strip()

# Agent lokal meminta antrian tiap N detik.
AGENT_INTERVAL_DETIK = int(os.getenv("AGENT_INTERVAL_DETIK", "10"))

# Jika antrian pending tidak diproses agent dalam N menit, bot meng-edit pesan
# status menjadi "Server Gladius tidak tersambung".
WAIT_ANNOUNCE_MENIT = int(os.getenv("WAIT_ANNOUNCE_MENIT", "3"))

# Port HTTP endpoint (Railway menyuntikkan $PORT; default 8080).
PORT_HTTP = int(os.getenv("PORT", "8080"))

# ==================== SELENIUM (dipakai AGENT LOKAL) ====================
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

# ==================== DROPDOWN DOMAIN & KOLOM PAKET ====================
# Domain yang dicoba berurutan sampai kolom "Paket Radius / Paket PCRF" berisi.
# Catatan: coba dulu dropdown apa adanya; baru loop daftar ini jika masih kosong.
DAFTAR_DOMAIN = [
    d.strip()
    for d in os.getenv(
        "DAFTAR_DOMAIN",
        "apps.telkom,telkom.net,gold.telkom,telkom.b2b",
    ).split(",")
    if d.strip()
]

# Kolom paket dianggap KOSONG bila isinya salah satu nilai di bawah ini.
NILAI_PAKET_KOSONG = {"/", "-", "", "0", "n/a", "na", "kosong", "null", "none"}

# Kata kunci teks kolom paket pada tabel hasil (dicari toleran).
TEKS_KOLOM_PAKET = os.getenv("TEKS_KOLOM_PAKET", "paket radius")
TEKS_KOLOM_PAKET_ALT = "paket pcrf"