# -*- coding: utf-8 -*-
"""Bot Telegram GetEmbassy (sisi Railway).

Menerima perintah dari user, mencatat permintaan cek embassy ke antrian
in-memory, lalu menyediakan endpoint HTTP publik yang ditanya-tanya oleh
agent lokal (laptop PIC) yang memegang Chrome + Gladius.

Alur:
  /embassy <nomor>  -> tulis antrian + balas "Embassy: mengukur ..."
  userscript (Tampermonkey di Chrome Gladius)
                   -> GET /antrian -> proses di halaman (html2canvas)
                      -> POST /kirim (foto base64 + info) -> bot send ke user
                      -> POST /selesai untuk pelaporan status gagal
  Jika antrian tidak diproses dalam WAIT_ANNOUNCE_MENIT menit, pesan status
  diedit menjadi "Server Gladius tidak tersambung".

Endpoint HTTP (semua butuh ?secret=AGENT_SECRET):
  GET  /antrian   -> daftar permintaan status=pending
  POST /kirim     -> relay foto hasil (base64) -> sendPhoto ke user + edit pesan
  POST /selesai   -> pelaporan status (id, status, pesan) + edit pesan gagal
  GET  /health    -> penanda bot hidup
"""

import asyncio
import base64
import io
import json
import logging
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from config import (
    AGENT_SECRET,
    DAFTAR_DOMAIN,
    PORT_HTTP,
    TOKEN,
    WAIT_ANNOUNCE_MENIT,
)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ==================== ANTRIAN (in-memory) ====================
# task_id -> {"nomor", "chat_id", "message_id", "waktu", "status", "pesan"}
_antrian: dict[str, dict] = {}
_antrian_lock = threading.Lock()
_id_counter = 0


def _tambah_task(nomor: str, chat_id: int, message_id: int) -> str:
    global _id_counter
    with _antrian_lock:
        _id_counter += 1
        task_id = f"T-{_id_counter}"
        _antrian[task_id] = {
            "nomor": nomor,
            "chat_id": chat_id,
            "message_id": message_id,
            "waktu": datetime.now().isoformat(timespec="seconds"),
            "status": "pending",
            "pesan": "",
        }
        return task_id


def _ambil_task(task_id: str) -> dict | None:
    with _antrian_lock:
        return _antrian.get(task_id)


def _ambil_pending() -> list[dict]:
    with _antrian_lock:
        return [
            {
                "id": i,
                "nomor": t["nomor"],
                "chat_id": t["chat_id"],
                "message_id": t["message_id"],
            }
            for i, t in _antrian.items()
            if t["status"] == "pending"
        ]


def _tandai_task(task_id: str, status: str, pesan: str = "") -> None:
    with _antrian_lock:
        if task_id in _antrian:
            _antrian[task_id]["status"] = status
            _antrian[task_id]["pesan"] = pesan


def _ringkasan_status() -> str:
    with _antrian_lock:
        if not _antrian:
            return (
                "Bot online ✓\n"
                "Belum ada permintaan /embassy terakhir.\n"
                "Kirim /embassy <nomor> lalu lihat apakah ada balasan hasil."
            )
        terakhir = max(_antrian.values(), key=lambda t: t["waktu"])
        st = terakhir["status"]
        jam = terakhir["waktu"].replace("T", " ")[:19]
        if st == "pending":
            kondisi = "permintaan terakhir masih menunggu agent (agent/Gladius belum merespons)."
        elif st == "selesai":
            kondisi = "agent aktif ✓ (permintaan terakhir selesai diproses)."
        else:
            kondisi = "agent tidak terdeteksi pada permintaan terakhir."
        return f"Bot online ✓\n{kondisi}\nTerakhir: {jam} ({st})"


# ==================== TELEGRAM API (relay foto dari userscript) ====================
_TELEGRAM_API = f"https://api.telegram.org/bot{TOKEN}"


def _tele_post(path: str, files=None, data: dict | None = None) -> dict:
    try:
        r = requests.post(
            f"{_TELEGRAM_API}/{path}",
            files=files,
            data=data or {},
            timeout=120,
        )
        return r.json()
    except Exception as exc:
        logger.warning("Telegram API %s gagal: %s", path, exc)
        return {"ok": False}


def _caption_hasil(nomor: str, waktu: str, paket_ok: bool, lfu_ok: bool) -> str:
    caption = f"Embassy {nomor} | {waktu}"
    if not paket_ok:
        caption += (
            f"\nPaket Radius/PCRF tidak ditemukan dalam "
            f"{len(DAFTAR_DOMAIN)} domain."
        )
    elif not lfu_ok:
        caption += (
            "\nLast Five Usage gagal atau tidak selesai dimuat. "
            "Gambar berikut adalah hasil Embassy sebelum percobaan riwayat."
        )
    return caption


# ==================== HTTP ENDPOINT (dipanggil userscript Tampermonkey) ====================
class _Handler(BaseHTTPRequestHandler):
    def _kirim(self, kode: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(kode)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sekret_ok(self) -> bool:
        qs = parse_qs(urlparse(self.path).query)
        return (qs.get("secret", [""])[0] or "") == AGENT_SECRET

    def _baca_json(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._kirim(200, {"ok": True})
            return
        if not self._sekret_ok():
            self._kirim(403, {"ok": False, "error": "secret salah"})
            return
        if path == "/antrian":
            self._kirim(200, {"ok": True, "items": _ambil_pending()})
        else:
            self._kirim(404, {"ok": False})

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._sekret_ok():
            self._kirim(403, {"ok": False, "error": "secret salah"})
            return
        if path == "/selesai":
            data = self._baca_json()
            tid = str(data.get("id", ""))
            status = data.get("status", "selesai")
            pesan = data.get("pesan", "")
            if tid:
                _tandai_task(tid, status, pesan)
                if status == "gagal" and pesan:
                    chat_id = data.get("chat_id")
                    message_id = data.get("message_id")
                    nomor = str(data.get("nomor", ""))
                    if chat_id is not None and message_id is not None:
                        _tele_post(
                            "editMessageText",
                            data={
                                "chat_id": chat_id,
                                "message_id": message_id,
                                "text": f"Gagal memeriksa Embassy {nomor}:\n{pesan}"[:1024],
                            },
                        )
            self._kirim(200, {"ok": True})
        elif path == "/kirim":
            self._proses_kirim_hasil()
        else:
            self._kirim(404, {"ok": False})

    def _proses_kirim_hasil(self):
        """Terima foto hasil dari userscript (base64) -> sendPhoto + edit pesan."""
        data = self._baca_json()
        tid = str(data.get("id", ""))
        chat_id = data.get("chat_id")
        message_id = data.get("message_id")
        nomor = str(data.get("nomor", ""))
        foto_b64 = data.get("foto", "")
        paket_ok = bool(data.get("paket_ok"))
        lfu_ok = bool(data.get("lfu_ok"))
        waktu = str(data.get("waktu", ""))

        if not (tid and chat_id is not None and message_id is not None and foto_b64):
            self._kirim(200, {"ok": False, "error": "payload tidak lengkap"})
            return

        try:
            foto_bytes = base64.b64decode(foto_b64)
        except Exception:
            self._kirim(200, {"ok": False, "error": "base64 foto tidak valid"})
            return

        caption = _caption_hasil(nomor, waktu, paket_ok, lfu_ok)
        terkirim = _tele_post(
            "sendPhoto",
            files={"photo": io.BytesIO(foto_bytes)},
            data={"chat_id": chat_id, "caption": caption},
        ).get("ok", False)

        if terkirim:
            _tele_post(
                "editMessageText",
                data={
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": "Selesai ✓",
                },
            )
            _tandai_task(tid, "selesai", "")
        else:
            _tandai_task(tid, "selesai", "gagal kirim foto dari userscript")

        self._kirim(200, {"ok": True, "sent": terkirim})

    def log_message(self, *args):
        pass


def _jalankan_http_server() -> None:
    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT_HTTP), _Handler)
        logger.info("HTTP endpoint aktif di port %s", PORT_HTTP)
        server.serve_forever()
    except Exception as exc:
        logger.warning("HTTP server gagal: %s", exc)


# ==================== PERINTAH TELEGRAM ====================
BANTUAN_TEXT = (
    "GetEmbassy Bot\n\n"
    "Cara pakai:\n"
    "/embassy <nomor>  cek kualitas jaringan embassy & kirim hasil (1 screenshot)\n"
    "/status           cek status bot / agent\n"
    "/start /help      bantuan ini\n\n"
    "Contoh:\n"
    "/embassy 121519246796"
)

PESAN_TIDAK_TERSAMBUNG = (
    "⚠️ Server Gladius tidak tersambung.\n"
    "Petugas yang menjaga bot belum aktif / Chrome Gladius belum berjalan.\n"
    "Silakan dicoba lagi nanti."
)


async def cmd_bantuan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        await update.message.reply_text(BANTUAN_TEXT)


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        await update.message.reply_text(_ringkasan_status())


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

    status_msg = await msg.reply_text(f"Embassy: mengukur {nomor}")
    task_id = _tambah_task(nomor, msg.chat_id, status_msg.message_id)
    logger.info("Antrian %s: nomor %s dari chat %s", task_id, nomor, msg.chat_id)

    context.application.create_task(
        _pantau_timeout(context.application, task_id, nomor)
    )


async def _pantau_timeout(application, task_id: str, nomor: str) -> None:
    await asyncio.sleep(WAIT_ANNOUNCE_MENIT * 60)
    task = _ambil_task(task_id)
    if not task or task["status"] != "pending":
        return
    try:
        await application.bot.edit_message_text(
            chat_id=task["chat_id"],
            message_id=task["message_id"],
            text=PESAN_TIDAK_TERSAMBUNG,
        )
    except Exception as exc:
        logger.warning("Gagal edit pesan timeout: %s", exc)
    _tandai_task(task_id, "timeout", "tidak diproses agent")


# ==================== MAIN ====================
def main() -> None:
    threading.Thread(target=_jalankan_http_server, daemon=True).start()

    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler(["start", "help"], cmd_bantuan))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("embassy", cmd_embassy))
    logger.info("Bot GetEmbassy jalan - poll status...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()