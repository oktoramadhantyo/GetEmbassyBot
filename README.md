# Projek Magang - GetEmbassy

Bot Telegram (Python) untuk memeriksa nomor Embassy di Web Gladius dan mengirim 1 screenshot hasilnya ke user Telegram.

Arsitektur: **bot di Railway (online 24 jam) + agent lokal di laptop PIC** (yang memegang Chrome yang sudah login Gladius). Tidak perlu Google Sheets / tunnel — agent menanya antrian ke Railway via HTTP.

## Arsitektur

```
[User Telegram]
     │  /embassy 121519246796
     ▼
[RAILWAY: bot.py]  (PTB polling + HTTP endpoint mini)
     │  catat antrian di RAM          ▲──── daemon 24 jam
     ▼                                 │
[GET /antrian?secret=...]──────┐       │
                                ▼       │
[laptop PIC: agent.py]   (tiap 10 dtk)  │
     │  attach Chrome debug port 9222                        │
     │  (login Gladius) → cek embassy → 1 screenshot          │
     ├── sendPhoto (langsung balas user via bot API)          │
     └── POST /selesai?secret=... (infokan selesai/gagal) ────┘
```

Jika antrian pending tidak diproses agent dalam `WAIT_ANNOUNCE_MENIT` menit, bot mengedit pesan user menjadi:

```
⚠️ Server Gladius tidak tersambung.
Petugas yang menjaga bot belum aktif / Chrome Gladius belum berjalan.
Silakan dicoba lagi nanti.
```

## Perintah Bot

| Perintah | Fungsi |
|---|---|
| `/embassy <nomor>` | Cek kualitas jaringan embassy & kirim 1 screenshot |
| `/status` | Status bot / indikasi agent aktif |
| `/start`, `/help` | Bantuan |

## Struktur Proyek

```
Projek Magang-GetEmbassy/
├── README.md
├── bot.py               # sisi RAILWAY: PTB polling + antrian + HTTP /antrian /selesai /health
├── agent.py             # sisi LOKAL (laptop PIC): polling antrian → Selenium → kirim hasil
├── config.py            # konfigurasi pusat via .env
├── scraper/
│   ├── browser.py       # cek debug port + attach Chrome login existing
│   └── embassy.py       # cari + 1 screenshot embassy & last five usage
├── requirements.txt
├── .env.example         # template .env
├── .env                 # (gitignored) token & setting
├── Procfile             # web: python bot.py
├── Screenshot 2026-09-22 125002.png
└── outputs/             # hasil screenshot (gitignored)
```

## Teknologi

- Python 3.13
- `python-telegram-bot` (polling)
- `selenium` (agent lokal, attach ke Chrome yang sudah login — pola BotInsera)
- `requests` (agent → Telegram Bot API & Railway)
- `python-dotenv`

## Setup & Cara Menjalankan

### 1. Install dependensi

```bash
pip install -r requirements.txt
```

### 2. Konfigurasi `.env`

```bash
copy .env.example .env
```

Isi: `TELEGRAM_BOT_TOKEN`, `RAILWAY_URL`, `AGENT_SECRET`.

### 3. Deploy bot (Railway)

1. Push repo ke GitHub.
2. Railway → **New Project → Deploy from GitHub** → pilih repo `GetEmbassyBot`.
3. Set **Variables**:
   - `TELEGRAM_BOT_TOKEN`
   - `AGENT_SECRET` (nilai diterima spesifik SAMA dengan `.env` agent)
   - `WAIT_ANNOUNCE_MENIT` (opsional)
4. Railway otomatis mendeteksi `Procfile` (`web: python bot.py`) dan mengekspos URL publik, misal `https://getembassybot.up.railway.app`.
5. Salin URL itu ke `.env` agent (`RAILWAY_URL`).
6. Cek endpoint di browser: `https://<url>.up.railway.app/health` → `{"ok": true}`.

> Catatan: `PORT` di-inject otomatis oleh Railway; batas `WAIT_ANNOUNCE_MENIT` untuk announce "tidak tersambung".

### 4. Jalankan agent lokal (laptop PIC)

1. Buka Chrome dengan remote debugging:

   ```powershell
   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
   ```

2. Login Gladius → buka halaman embassy → biarkan tab terbuka.
3. Jalankan agent:

   ```bash
   python agent.py
   ```

> Satu user/PIC harus menjaga Chrome ini tetap menyala + login agar robot bisa dipakai. Jika tidak, bot otomatis menginfokan "Server Gladius tidak tersambung".

### Test tanpa Telegram (opsional)

```bash
python -m scraper.embassy 121519246796 --dump
```

## Catatan Selector

Selector halaman Gladius belum terdokumentasi; elemen dicari toleran berdasarkan teks ("Cek Kualitas Jaringan", "Last Five Usage") dan field input Nomor Internet. Divalidasi saat test langsung — jika tombol tidak ketemu, hasil dump di atas membantu menyesuaikan.

## Progress / Checklist

- [x] Deskripsi alur bot & pesan output
- [x] Konfirmasi URL + cara masuk Web Gladius
- [x] Handler `/embassy <nomor>`
- [x] Announcement "Server Gladius tidak tersambung" + `/status`
- [x] Arsitektur Railway + agent lokal (tanpa Google Sheets/tunnel)
- [x] Scraper pencarian nomor embassy di Web Gladius
- [x] Screenshot hasil Embassy + Last Five Usage (1 gambar)
- [x] Penanganan gagal riwayat → tetap kirim screenshot Embassy
- [ ] Test end-to-end via Telegram (validasi selector & posisi screenshot)
- [ ] Deploy Railway + jalankan agent