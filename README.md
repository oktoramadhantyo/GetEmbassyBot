# Projek Magang - GetEmbassy

Bot Telegram untuk memeriksa nomor Embassy di Web Gladius dan mengirim 1 screenshot hasilnya ke user Telegram.

Arsitektur: **bot di Railway (online 24 jam) + UserScript Tampermonkey di browser laptop PIC** (yang memegang session login Gladius). Tidak perlu Python lokal / Selenium / Chrome debug port. UserScript menanya antrian ke Railway via HTTP, memproses cek embassy langsung di dalam halaman Gladius, lalu mengirim screenshot (html2canvas) kembali ke Railway untuk dikirim ke user.

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
[Chrome PIC: gladius-embassy.user.js] (tiap 10 dtk, Tampermonkey)
     │  halaman Gladius sudah login
     │  → isi nomor → Cek Kualitas Jaringan → loop domain
     │    sampai Paket Radius/PCRF berisi → Last Five Usage
     │  → screenshot html2canvas → base64
     ├── POST /kirim?secret=... (foto + caption → Railway kirim ke user)
     └── POST /selesai?secret=... (laporan gagal jika perlu)
```

Jika antrian pending tidak diproses dalam `WAIT_ANNOUNCE_MENIT` menit, bot mengedit pesan user menjadi:

```
⚠️ Server Gladius tidak tersambung.
Petugas yang menjaga bot belum aktif / Chrome Gladius belum berjalan.
Silakan dicoba lagi nanti.
```

> Versi lama (Python lokal: `agent.py` + Selenium + Chrome debug port) tetap disimpan sebagai referensi, tetapi **tidak lagi dipakai**. Nilai selector sama, jadi test `python -m scraper.embassy <nomor> --dump` tetap berguna untuk validasi struktur halaman.

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
├── bot.py                    # sisi RAILWAY: PTB polling + antrian + HTTP /antrian /kirim /selesai /health
├── agent.py                  # (LAMA, opsional) agent Selenium lokal
├── config.py                 # konfigurasi pusat via .env
├── gladius-embassy.user.js   # (BARU) UserScript Tampermonkey di Chrome PIC — jalankan proses cek embassy
├── scraper/
│   ├── browser.py            # (dipakai agent.py lama) cek debug port + attach Chrome login existing
│   └── embassy.py            # logika cek embassy (sumber JS selector + test CLI --dump)
├── requirements.txt
├── .env.example              # template .env
├── .env                      # (gitignored) token & setting
├── Procfile                  # web: python bot.py
├── start_agent.bat           # (LAMA, opsional) auto Chrome debug + run agent lama
├── Screenshot 2026-09-22 125002.png
└── outputs/                  # hasil screenshot (gitignored)
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
5. Salin URL itu ke `RAILWAY_URL` (di `.env` dan di konfigurasi userscript).
6. Cek endpoint di browser: `https://<url>.up.railway.app/health` → `{"ok": true}`.

> Catatan: `PORT` di-inject otomatis oleh Railway; batas `WAIT_ANNOUNCE_MENIT` untuk announce "tidak tersambung".

### 4. Pasang UserScript Tampermonkey (laptop PIC)

1. Pasang ekstensi **Tampermonkey** di Chrome.
2. Buat script baru → tempel isi `gladius-embassy.user.js`.
3. Sesuaikan bagian **KONFIGURASI** di atas file:
   - `RAILWAY_URL` = URL bot di Railway.
   - `AGENT_SECRET` = sama persis dengan value di Railway/`.env`.
4. Buka halaman embassy Gladius → **login** → biarkan tab ini selalu terbuka:
   `https://gladius.telkom.co.id/radonline/newradonline`
5. Pastikan badge **🟢 GetEmbassy: idle** muncul di bawah kanan. Klik tombol `⏸ Auto: ON` untuk mati/nyalakan (mudah dicek).

> Satu user/PIC harus menjaga tab Chrome ini tetap menyala + login agar robot bisa dipakai. Tidak perlu Python/Selenium/debug port lagi. Jika tab mati, bot otomatis menginfokan "Server Gladius tidak tersambung".
>
> **Catatan reload:** halaman Gladius memang me-reload tiap kali tombol Cek/Last Five diklik dan kadang auto-refresh sendiri. Script menoleransi itu — ia menyimpan checkpoint per langkah dan **melanjutkan dari langkah terakhir** setelah reload (badge akan menunjuk `↩️ Lanjut <nomor> ...`), bukan mengulang dari nol. Karena refresh selalu menutup kembali panel "Last Five Usage", pada resume step `lfu` tombol LFU **diklik ulang** sebelum screenshot biar hasilnya tetap memuat tabel Last Five Usage.

### Test tanpa Telegram (opsional)

```bash
python -m scraper.embassy 121519246796 --dump
```

## Alur Dropdown Domain (Paket Radius / PCRF)

1. Saat pertama **Cek Kualitas Jaringan** dgn dropdown apa adanya.
2. Baca kolom **Paket Radius / Paket PCRF** pada tabel hasil:
   - **sudah berisi** → lanjut ke "Last Five Usage";
   - **kosong** (mis. `/`, `-`) → ganti dropdown domain ke `DAFTAR_DOMAIN`
     (default `apps.telkom`, `telkom.net`, `gold.telkom`, `telkom.b2b`),
     klik **Cek Kualitas Jaringan** lagi → ulangi sampai kolom paket berisi
     atau semua domain sudah dicoba.
3. **Last Five Usage** dipanggil **hanya** jika kolom paket sudah berisi.
4. Jika SEMUA domain kosong → tetap kirim screenshot Embassy + catatan
   "Paket Radius/PCRF tidak ditemukan dalam N domain."

## Catatan Selector

Selector halaman Gladius belum terdokumentasi; elemen dicari toleran berdasarkan teks ("Cek Kualitas Jaringan", "Last Five Usage"), input Nomor Internet, `<select>` dropdown domain (heuristik opsi bertanda titik), dan kolom paket ("paket radius"/"paket pcrf"). Divalidasi saat test langsung — jika tidak cocok, hasil dump di atas membantu menyesuaikan.

## Progress / Checklist

- [x] Deskripsi alur bot & pesan output
- [x] Konfirmasi URL + cara masuk Web Gladius
- [x] Handler `/embassy <nomor>`
- [x] Announcement "Server Gladius tidak tersambung" + `/status`
- [x] Arsitektur Railway + agent (awalnya agent lokal, lihat bawah)
- [x] Scraper pencarian nomor embassy di Web Gladius
- [x] Screenshot hasil Embassy + Last Five Usage (1 gambar)
- [x] Penanganan gagal riwayat → tetap kirim screenshot Embassy
- [x] UserScript Tampermonkey `gladius-embassy.user.js` (ganti agent Python-lokal: polling `/antrian`, proses di halaman, html2canvas screenshot, kirim ke `/kirim`)
- [x] Railway endpoint `/kirim` (relay foto base64 → sendPhoto + edit pesan) & `/selesai` (edit pesan gagal)
- [ ] Test end-to-end via Telegram: pasang userscript di Chrome PIC, kirim `/embassy <nomor>`, validasi selector/posisi screenshot (html2canvas — ingat risiko iframe)
- [ ] Deploy Railway versi baru (dengan `/kirim`) + jalankan browser PIC dengan userscript aktif