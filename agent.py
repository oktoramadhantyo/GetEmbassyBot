# -*- coding: utf-8 -*-
"""Agent lokal GetEmbassy — berjalan di laptop PIC yang punya Chrome + login Gladius.

Loop:
  1. Minta antrian pending ke bot Railway: GET {RAILWAY_URL}/antrian?secret=...
  2. Untuk setiap permintaan:
     - edit pesan status user menjadi "Embassy: mengukur <nomor>"
     - cek Chrome debug port terbuka (jika tidak -> info tidak tersambung)
     - attach Chrome, jalankan scraper.embassy.cek_embassy (1 screenshot)
     - kirim screenshot + caption langsung ke user via Telegram Bot API
     - edit pesan status menjadi "Selesai ✓" / pesan gagal
  3. Lapor hasil ke Railway: POST {RAILWAY_URL}/selesai?secret=...

Agent TIDAK polling getUpdates, hanya mengirim — aman berdampingan dengan
polling di Railway.

Cara pakai:  python agent.py
Syarat: .env lokal (TOKEN, RAILWAY_URL, AGENT_SECRET, GLADIUS_URL, DEBUG_PORT)
        dan Chrome berjalan dengan --remote-debugging-port=9222 + login Gladius.
"""

import json
import logging
import time
from pathlib import Path

import requests

import config
from scraper import browser, embassy

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

_TELEGRAM_API = f"https://api.telegram.org/bot{config.TOKEN}"

PESAN_TIDAK_TERSAMBUNG = (
    "⚠️ Server Gladius tidak tersambung.\n"
    "Chrome debug port belum aktif atau belum login Gladius.\n"
    "Minta petugas yang menjaga bot untuk memeriksanya, lalu ulangi /embassy <nomor>."
)


def _api(path: str, files=None, data: dict | None = None) -> dict:
    r = requests.post(
        f"{_TELEGRAM_API}/{path}",
        data=data or {},
        files=files,
        timeout=120,
    )
    return r.json()


def kirim_foto(chat_id: int, path_img: Path, caption: str) -> bool:
    with open(path_img, "rb") as f:
        hasil = _api(
            "sendPhoto",
            files={"photo": f},
            data={"chat_id": chat_id, "caption": caption},
        )
    return bool(hasil.get("ok"))


def edit_pesan(chat_id: int, message_id: int, teks: str) -> bool:
    hasil = _api(
        "editMessageText",
        data={
            "chat_id": chat_id,
            "message_id": message_id,
            "text": teks,
        },
    )
    return bool(hasil.get("ok"))


def ambil_antrian() -> list[dict]:
    if not config.RAILWAY_URL:
        raise RuntimeError(
            "RAILWAY_URL belum di-set di .env (URL publik bot Railway)."
        )
    r = requests.get(
        f"{config.RAILWAY_URL}/antrian",
        params={"secret": config.AGENT_SECRET},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"GET /antrian gagal: HTTP {r.status_code}")
    return r.json().get("items", [])


def laporkan(task_id: str, status: str, pesan: str = "") -> None:
    try:
        requests.post(
            f"{config.RAILWAY_URL}/selesai",
            params={"secret": config.AGENT_SECRET},
            json={"id": task_id, "status": status, "pesan": pesan},
            timeout=30,
        )
    except Exception as exc:
        logger.warning("Gagal lapor ke Railway: %s", exc)


def proses(task: dict) -> None:
    tid = task["id"]
    nomor = task["nomor"]
    chat_id = task["chat_id"]
    message_id = task["message_id"]
    logger.info("Proses %s: nomor %s", tid, nomor)

    edit_pesan(chat_id, message_id, f"Embassy: mengukur {nomor}")

    if not browser.cek_debug_port_terbuka():
        edit_pesan(chat_id, message_id, PESAN_TIDAK_TERSAMBUNG)
        laporkan(tid, "gagal", "Chrome debug port tidak terbuka")
        return

    driver = browser.buat_driver()
    try:
        hasil = embassy.cek_embassy(driver, nomor)
    except Exception as exc:
        logger.exception("Gagal cek embassy %s", nomor)
        edit_pesan(
            chat_id,
            message_id,
            f"Gagal memeriksa Embassy {nomor}:\n{str(exc)[:300]}",
        )
        laporkan(tid, "gagal", str(exc))
        return
    finally:
        browser.tutup(driver)

    caption = f"Embassy {hasil['nomor']} | {hasil['waktu']}"
    if not hasil.get("paket_ok"):
        caption += (
            f"\nPaket Radius/PCRF tidak ditemukan dalam "
            f"{len(config.DAFTAR_DOMAIN)} domain."
        )
    elif not hasil.get("lfu_ok"):
        caption += (
            "\nLast Five Usage gagal atau tidak selesai dimuat. "
            "Gambar berikut adalah hasil Embassy sebelum percobaan riwayat."
        )

    if kirim_foto(chat_id, hasil["screenshot"], caption):
        edit_pesan(chat_id, message_id, "Selesai ✓")
        pesan = ""
    else:
        pesan = "gagal kirim foto, screenshot disimpan lokal"
        edit_pesan(
            chat_id,
            message_id,
            f"Gagal mengirim foto. Screenshot tersimpan di: {hasil['screenshot']}",
        )
    laporkan(tid, "selesai", pesan)


def main() -> None:
    logger.info("Agent lokal dimulai (interval %s detik)", config.AGENT_INTERVAL_DETIK)
    while True:
        try:
            items = ambil_antrian()
            for task in items:
                try:
                    proses(task)
                except Exception as exc:
                    logger.exception("Error proses task %s", task.get("id"))
                    laporkan(task.get("id", ""), "gagal", str(exc))
        except Exception as exc:
            logger.warning("Gagal ambil antrian: %s", exc)
        time.sleep(config.AGENT_INTERVAL_DETIK)


if __name__ == "__main__":
    main()