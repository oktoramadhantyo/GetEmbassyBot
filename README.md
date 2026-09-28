# Projek Magang - GetEmbassy

Bot Telegram untuk memeriksa nomor Embassy atau Password Check di Web Gladius dan mengirim 1 screenshot hasilnya ke user Telegram.

Arsitektur: **bot.py di server + UserScript Tampermonkey di browser PIC** (yang memegang session login Gladius). UserScript menanya antrian ke server bot via HTTP, memproses Embassy atau Password Check langsung di dalam halaman Gladius, lalu mengirim screenshot (html2canvas) kembali ke server bot untuk dikirim ke user.

> **Status sekarang: dijalankan LOKAL.** `bot.py` jalan di PC yang sama dengan browser Gladius (`http://127.0.0.1:8080`), jadi tidak ada biaya hosting, tidak ada sleep/cold-start. Kode `bot.py` tidak berubah sama sekali — hanya URL di userscript yang berbeda. Kalau nanti mau pindah ke Railway, cukup ganti `SERVER_BOT` di `gladius-embassy.user.js` (dan tambahkan host-nya ke `@connect`).

## Arsitektur

```
[User Telegram]
     │  /embassy 121519246796 atau /password 121519246796
     ▼
[SERVER BOT: bot.py]  (PTB polling + HTTP endpoint mini)
     │  catat antrian di RAM          ▲──── daemon 24 jam
     ▼                                 │
[GET /antrian?secret=...]──────┐       │
                                ▼       │
[Chrome PIC: gladius-embassy.user.js] (tiap 10 dtk, Tampermonkey)
     │  halaman Gladius sudah login
     │  → isi nomor → Cek Kualitas Jaringan / Password Check
     │    → proses sesuai jenis → screenshot
     │  → screenshot html2canvas → base64
     ├── POST /kirim?secret=... (foto + caption → server kirim ke user)
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
| `/password <nomor>` | Cek status password & kirim 1 screenshot |
| `/status` | Status bot / indikasi agent aktif |
| `/start`, `/help` | Bantuan |

## Struktur Proyek

```
Projek Magang-GetEmbassy/
├── README.md
├── bot.py                    # SERVER BOT: PTB polling + antrian + HTTP /antrian /kirim /selesai /health
├── start_bot.bat             # (lokal) jalankan bot.py + auto-restart + tulis logs/bot.log
├── agent.py                  # (LAMA, opsional) agent Selenium lokal
├── config.py                 # konfigurasi pusat via .env
├── gladius-embassy.user.js   # UserScript Tampermonkey di Chrome PIC — proses Embassy/Password Check
├── scraper/
│   ├── browser.py            # (dipakai agent.py lama) cek debug port + attach Chrome login existing
│   └── embassy.py            # logika cek embassy (sumber JS selector + test CLI --dump)
├── requirements.txt
├── .env.example              # template .env
├── .env                      # (gitignored) token & setting
├── Procfile                  # web: python bot.py  (hanya dipakai kalau deploy di Railway)
├── start_agent.bat           # (LAMA, opsional) auto Chrome debug + run agent lama
├── Screenshot 2026-09-22 125002.png
├── outputs/                  # hasil screenshot (gitignored)
└── logs/                     # log bot lokal (gitignored)
```

## Teknologi

- Python 3.13
- `python-telegram-bot` (polling)
- `selenium` (agent lokal, attach ke Chrome yang sudah login — pola BotInsera)
- `requests` (agent → Telegram Bot API & relay foto)
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

Isi minimal untuk lokal: `TELEGRAM_BOT_TOKEN` + `AGENT_SECRET`. `RAILWAY_URL` tidak dipakai saat lokal.

### 3. Jalankan bot (lokal)

Cukup dobel-klik **`start_bot.bat`**. File itu akan:

- menjalankan `python bot.py`,
- menulis semua output ke `logs\bot.log`,
- **menyalakan ulang otomatis** kalau bot crash atau ditutup paksa (delay 5 detik),
- menolak start kalau ternyata sudah ada bot yang jalan di port 8080 (mencegah konflik `getUpdates`).

Atau jalankan manual kalau sedang mau lihat log langsung di layar:

```bat
cd /d "C:\Users\diana\Downloads\MAGANGG\Projek Magang-GetEmbassy"
python bot.py
```

Cek bot hidup: buka `http://127.0.0.1:8080/health` di browser → harusnya `{"ok": true}`.

Untuk berhenti: tutup jendela `start_bot.bat`, atau `Ctrl+C` lalu `Y`.

#### Supaya bot nyala sendiri setelah PC restart

1. Nonaktifkan sleep/hibernate di **Settings → System → Power & battery** (PC tidak boleh tidur).
2. **Task Scheduler** → **Create Task**:
   - Trigger: *At startup*
   - Action: browse ke `start_bot.bat` di folder proyek ini
   - Centang **"Run whether user is logged on or not"**
   - Tab Settings → centang **"If the task fails, restart every 1 minute"**
3. Kalau dipindah ke PC lain, jalankan ulang `regasm`/sesuaikan Working Directory-nya.

#### Kalau botnya di PC berbeda dari browser

- `bot.py` sudah bind `0.0.0.0`, tapi butuh **firewall rule buka port 8080** di PC server.
- Pakai **IP LAN statis** (DHCP reservation di router), supaya URL userscript tidak berubah-ubah.
- Di userscript, set `SERVER_BOT = "http://192.168.x.x:8080"` **dan** tambahkan `@connect 192.168.x.x`.

### 3b. Deploy bot (Railway, opsional)

Kalau nanti mau pindah ke Railway:

1. Push repo ke GitHub.
2. Railway → **New Project → Deploy from GitHub** → pilih repo `GetEmbassyBot`.
3. Set **Variables**: `TELEGRAM_BOT_TOKEN`, `AGENT_SECRET`, `WAIT_ANNOUNCE_MENIT` (opsional).
4. Railway membaca `Procfile` (`web: python bot.py`) dan mengekspos URL publik.
5. Di userscript, set `SERVER_BOT` ke URL itu **dan** tambahkan host-nya ke `@connect`.
6. Cek `https://<url>.up.railway.app/health` → `{"ok": true}`.

> Railway menyuntikkan `PORT` sendiri. Pastikan **tidak** ada bot lokal yang masih jalan, karena akan konflik `getUpdates`.

### 4. Pasang UserScript Tampermonkey (browser PIC)

1. Pasang ekstensi **Tampermonkey** di Chrome.
2. Buat script baru → tempel isi `gladius-embassy.user.js`.
3. Sesuaikan bagian **KONFIGURASI** di atas file:
   - `SERVER_BOT` = URL server bot. Lokal (PC sama): `http://127.0.0.1:8080`.
   - `AGENT_SECRET` = sama persis dengan value di `.env`.
   - **Host yang dipakai juga harus terdaftar di `@connect`** (baris paling atas file). Ini wajib — kalau tidak, polling gagal diam-diam tanpa error yang kelihatan.
   - `SS_CROP = "auto"` = screenshot di-crop ke area hasil ukur saja (sidebar/logo Gladius + tabel hasil + Last Five Usage), `SS_SCALE` = tingkat kecil/besar (default `1`). Kalau auto-crop kurang pas, isi `SS_CROP_OVERRIDE` mis. `{left: 0, top: 0, right: 1400, bottom: 2100}` untuk angka pasti.
4. Buka halaman Gladius → **login** → biarkan tab ini selalu terbuka. Bot dapat membuka halaman Embassy atau Password Check sesuai permintaan.
5. Pastikan badge **🟢 GetEmbassy: idle** muncul di bawah kanan. Klik tombol `ON`/`OFF` untuk menyalakan atau mematikan.

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

Selector halaman Gladius belum terdokumentasi; elemen dicari toleran berdasarkan teks ("Cek Kualitas Jaringan", "Password Check", "Last Five Usage"), input Nomor Internet, navigasi menu, `<select>` dropdown domain (heuristik opsi bertanda titik), dan kolom paket/status. Divalidasi saat test langsung — jika tidak cocok, hasil dump di atas membantu menyesuaikan.

## Catatan Penting Mode Lokal

- **Queue bot ada di RAM.** Kalau `bot.py` mati (PC restart, crash, battery habis) saat ada antrian aktif, task itu hilang dan pesan user menggantung di "mengukur…" tanpa pernah diedit jadi gagal. Task yang belum diproses tidak akan dilanjutkan setelah bot start ulang.
- **PC harus tidak tidur.** Kalau PC sleep, bot mati dan `/status` tidak akan dijawab.
- **Jangan jalan 2 instance.** `python bot.py` yang dobel-dobel akan konflik di `getUpdates` Telegram. `start_bot.bat` sudah cek `/health` dulu untuk mencegahnya, tapi kalau kamu jalankan `python bot.py` manual bersamaan dengan `.bat`, penjaga itu tidak berlaku.
- **Satu titik gagal.** benefitnya: tidak ada server lain yang bisa mati. Di Railway/Render/HF, ada 3 titik (PC PIC + provider + service). Di lokal, hanya 1 — tapi itu juga artinya kalau PC-nya mati, bot langsung mati.
- **Log.** Semua output ada di `logs\bot.log`. Kalau bot tiba-tiba tidak merespons, cek file ini dulu — biasanya ada traceback di baris terakhir.
- **Secret.** `AGENT_SECRET` ada di dalam `gladius-embassy.user.js`. Repo GitHub-nya public, jadi kalau nanti dipakai lewat IP LAN atau deploy publik, putar nilai `AGENT_SECRET` ini sekali (ganti di userscript + `.env` + Railway Variables).

## Progress / Checklist

- [x] Deskripsi alur bot & pesan output
- [x] Konfirmasi URL + cara masuk Web Gladius
- [x] Handler `/embassy <nomor>` dan `/password <nomor>`
- [x] Announcement "Server Gladius tidak tersambung" + `/status`
- [x] Arsitektur server bot + agent (awalnya agent lokal, lihat bawah)
- [x] Scraper pencarian nomor embassy di Web Gladius
- [x] Screenshot hasil Embassy/Password Check (1 gambar; nilai password dimasker)
- [x] Penanganan gagal riwayat → tetap kirim screenshot Embassy
- [x] UserScript Tampermonkey `gladius-embassy.user.js` (ganti agent Python-lokal: polling `/antrian`, proses di halaman, html2canvas screenshot, kirim ke `/kirim`)
- [x] Endpoint `/kirim` (relay foto base64 → sendPhoto + edit pesan) & `/selesai` (edit pesan gagal)
- [x] Pindah ke mode lokal: `start_bot.bat` + `SERVER_BOT` = `127.0.0.1:8080`
- [ ] Daftarkan `start_bot.bat` ke Task Scheduler (auto-start setelah PC restart)
- [ ] Test end-to-end via Telegram: jalankan bot, pasang userscript di Chrome, kirim `/embassy <nomor>`, validasi navigasi/selector/screenshot (html2canvas — ingat risiko iframe)
- [ ] Auto-start diuji (restart PC → bot harus up sendiri)