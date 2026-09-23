# -*- coding: utf-8 -*-
"""Bot Telegram GetEmbassy — memeriksa nomor embassy di Web Gladius.

Perintah:
  /embassy <nomor>  -> cek kualitas jaringan & kirim screenshot
  /status           -> cek koneksi server Gladius (Chrome debug port)
  /start, /help     -> bantuan
"""

import asyncio
import logging
import re
import threading

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from config import TOKEN
from scraper import browser, embassy

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Anti-bentrok: satu pengukuran pada satu waktu.
_lock = threading.Lock()

BANTUAN_TEXT = (
    "GetEmbassy Bot\n\n"
    "Cara pakai:\n"
    "/embassy <nomor>  cek kualitas jaringan embassy & kirim hasil (1 screenshot)\n"
    "/status           cek apakah server Gladius tersambung\n"
    "/start /help      bantuan ini\n\n"
    "Contoh:\n"
    "/embassy 121519246796"
)


async def cmd_bantuan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        await update.message.reply_text(BANTUAN_TEXT)


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message:
        return
    if browser.cek_debug_port_terbuka():
        await update.message.reply_text("Tersambung ✓ (Chrome debug port aktif)")
    else:
        await update.message.reply_text(
            "Tidak tersambung ✗\n\n"
            "Pastikan Chrome sudah berjalan dengan remote debugging:\n"
            'chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug"\n'
            "lalu login Gladius."
        )


async def cmd_embassy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg:
        return

    args = (msg.text or "").split()
    nomor = re.sub(r"\D", "", args[1]) if len(args) > 1 else ""
    if len(nomor) < 5:
        await msg.reply_text(
            "Gunakan: /embassy <nomor>\nContoh:\n/embassy 121519246796"
        )
        return

    status = await msg.reply_text(f"Embassy: mengukur {nomor}")

    if not browser.cek_debug_port_terbuka():
        await status.edit_text(
            "⚠️ Server Gladius tidak tersambung.\n\n"
            "Pastikan Chrome sudah berjalan dengan remote debugging:\n"
            'chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug"\n'
            "lalu login Gladius, dan ulangi:\n"
            f"/embassy {nomor}"
        )
        return

    try:
        with _lock:
            driver = browser.buat_driver()
            try:
                hasil = await asyncio.to_thread(embassy.cek_embassy, driver, nomor)
            finally:
                browser.tutup(driver)
    except Exception as exc:
        logger.exception("Gagal cek embassy")
        await status.edit_text(_teks_eror(exc, nomor))
        return

    caption = f"Embassy {hasil['nomor']} | {hasil['waktu']}"
    if not hasil.get("lfu_ok"):
        caption += (
            "\nLast Five Usage gagal atau tidak selesai dimuat. "
            "Gambar berikut adalah hasil Embassy sebelum percobaan riwayat."
        )

    try:
        with open(hasil["screenshot"], "rb") as f:
            await msg.reply_photo(photo=f, caption=caption)
        await status.edit_text("Selesai ✓")
    except Exception as exc:
        logger.exception("Gagal kirim foto")
        await status.edit_text(f"Gagal mengirim foto: {exc}")


def _teks_eror(exc: Exception, nomor: str) -> str:
    teks = f"Gagal memeriksa Embassy {nomor}:\n{exc}"
    return teks[:400]


def main() -> None:
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler(["start", "help"], cmd_bantuan))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("embassy", cmd_embassy))
    logger.info("Bot GetEmbassy jalan - poll status...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()