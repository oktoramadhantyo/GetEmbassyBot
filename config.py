# -*- coding: utf-8 -*-
"""Konfigurasi GetEmbassy (dibaca dari .env dengan fallback default).

Hanya dikonsumsi bot.py. Nilai userscript (gladius-embassy.user.js) adalah
hardcode sendiri dan HARUS sinkron dengan nilai di sini:
  - AGENT_SECRET  == AGENT_SECRET_BAKU di userscript
  - PORT_HTTP     == SERVER_BOT di userscript (127.0.0.1:8080)
  - DAFTAR_DOMAIN == DAFTAR_DOMAIN di userscript
"""

import os
import pathlib

from dotenv import load_dotenv

load_dotenv()

BASE = pathlib.Path(__file__).resolve().parent

# ==================== TELEGRAM BOT ====================
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
if not TOKEN:
    raise SystemExit(
        "TELEGRAM_BOT_TOKEN belum di-set. "
        "Buat file .env dari .env.example lalu isi token, "
        "atau set environment variable TELEGRAM_BOT_TOKEN."
    )

# Kata kunci rahasia antara bot server dan userscript. Wajib sama dengan
# hardcode AGENT_SECRET_BAKU di userscript.
AGENT_SECRET = os.getenv("AGENT_SECRET", "").strip()

# Jika antrian pending tidak diproses dalam N menit, bot meng-edit pesan
# status menjadi "Server Gladius tidak tersambung".
WAIT_ANNOUNCE_MENIT = int(os.getenv("WAIT_ANNOUNCE_MENIT", "3"))

# Port HTTP endpoint. Railway menyuntikkan $PORT; lokal default 8080 dan harus
# sama dengan SERVER_BOT di userscript.
PORT_HTTP = int(os.getenv("PORT", "8080"))

# ==================== DOMAIN GLADIUS ====================
# Domain yang dicoba berurutan sampai kolom "Paket Radius / Paket PCRF" berisi.
DAFTAR_DOMAIN = [
    d.strip()
    for d in os.getenv(
        "DAFTAR_DOMAIN",
        "apps.telkom,telkom.net,gold.telkom,telkom.b2b",
    ).split(",")
    if d.strip()
]