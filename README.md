# Projek Magang - GetEmbassy

Bot Telegram (Python) untuk memeriksa nomor Embassy di Web Gladius dan mengirim 1 screenshot hasilnya ke user Telegram.

## Alur Bot

1. User memanggil bot sekaligus menaruh nomor embassy yang mau dicek:

   ```
   /embassy 121519246796
   ```

2. Bot mengecek koneksi server Gladius. Jika tidak tersambung, bot memberi info:

   ```
   ⚠️ Server Gladius tidak tersambung.
   Pastikan Chrome sudah berjalan dengan remote debugging:
   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
   lalu login Gladius, dan ulangi:
   /embassy 121519246796
   ```

3. Jika tersambung, bot mencari nomor tersebut ke Web Gladius. Status yang ditampilkan:

   ```
   Embassy: mengukur 121519246796
   ```

4. Bot mencari nomor di halaman embassy, klik "Cek Kualitas Jaringan", lalu klik "Last Five Usage".

5. Bot mengambil SATU screenshot (full-page) berisi hasil Embassy + Last Five Usage, lalu mengirim ke user:

   - Gambar: `embassy_<nomor>_<timestamp>.png`
   - Pesan:

   ```
   Embassy 121519246796 | 22-09-2026 12:51:30
   ```

   Jika Last Five Usage gagal / tidak selesai dimuat, screenshot hasil Embassy TETAP dikirim:

   ```
   Embassy 121519246796 | 22-09-2026 12:51:30
   Last Five Usage gagal atau tidak selesai dimuat. Gambar berikut adalah hasil Embassy sebelum percobaan riwayat.
   ```

> Catatan: jika Last Five Usage gagal / tidak selesai dimuat, screenshot Embassy TETAP dikirim (hasil embassy prioritas utama).

## Perintah Bot

| Perintah | Fungsi |
|---|---|
| `/embassy <nomor>` | Cek kualitas jaringan embassy & kirim 1 screenshot |
| `/status` | Cek apakah server Gladius tersambung |
| `/start`, `/help` | Bantuan |

## Struktur Proyek

```
Projek Magang-GetEmbassy/
├── README.md
├── bot.py               # entry point python-telegram-bot (polling)
├── config.py            # konfigurasi pusat via .env
├── scraper/
│   ├── browser.py       # cek debug port + attach Chrome login existing
│   └── embassy.py       # cari + 1 screenshot embassy & last five usage
├── requirements.txt
├── .env.example         # template .env
├── .env                 # (gitignored) token & setting
├── Procfile             # worker: python bot.py
├── Screenshot 2026-09-22 125002.png
└── outputs/             # hasil screenshot (gitignored)
```

## Teknologi

- Python 3.13
- `python-telegram-bot` (polling)
- `selenium` (attach ke Chrome yang sudah login — pola BotInsera)
- `python-dotenv`

## Setup & Cara Menjalankan

### 1. Install dependensi (sekali)

```bash
pip install -r requirements.txt
```

### 2. Konfigurasi `.env`

```bash
copy .env.example .env
```

Isi `TELEGRAM_BOT_TOKEN` dengan token dari @BotFather.

### 3. Jalankan Chrome dengan remote debugging (di laptop yang jadi PIC)

Chrome HARUS berjalan dengan flag debugging dan sudah login Gladius:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
```

Buka `https://gladius.telkom.co.id/radonline/newradonline`, login Gladius (termasuk OTP), biarkan tab halaman embassy terbuka.

> Satu user/PIC harus menjaga Chrome ini tetap menyala + login agar bot bisa dipakai. Jika tidak, bot otomatis memberi info "Server Gladius tidak tersambung".

### 4. Jalankan bot

```bash
python bot.py
```

### Test tanpa Telegram (opsional)

```bash
python -m scraper.embassy 121519246796 --dump
```

## Catatan Selector

Selector halaman Gladius belum terdokumentasi; elemen dicari toleran berdasarkan teks ("Cek Kualitas Jaringan", "Last Five Usage") dan field input Nomor Internet. Divalidasi saat test langsung — jika tombol tidak ketemu, hasil dump di atas membantu menyesuaikan.

## Progress / Checklist

- [x] Deskripsi alur bot & pesan output
- [x] Penempatan contoh screenshot di folder proyek
- [x] Konfirmasi URL + cara masuk Web Gladius
- [x] Handler `/embassy <nomor>`
- [x] Announcement "Server Gladius tidak tersambung" + `/status`
- [x] Scraper pencarian nomor embassy di Web Gladius
- [x] Screenshot hasil Embassy + Last Five Usage (1 gambar)
- [x] Penanganan gagal riwayat → tetap kirim screenshot Embassy
- [x] Format pesan output sesuai contoh
- [ ] Test end-to-end via Telegram (validasi selector & posisi screenshot)