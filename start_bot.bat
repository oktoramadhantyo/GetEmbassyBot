@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title GetEmbassy Bot

REM ============================================================
REM  GetEmbassy - Bot Telegram LOKAL
REM  Dobel-klik file ini untuk menjalankan bot.py.
REM
REM  - Output tampil di jendela ini SEKALIGUS dicatat ke logs\bot.log
REM  - Bot dinyalakan ulang otomatis kalau crash (bisa dibatalkan)
REM  - Menolak start kalau sudah ada bot yang jalan di port yang sama
REM
REM  Berhenti sementara : tekan Ctrl+C, lalu jawab N saat ditanya.
REM  Berhenti permanen  : buat file logs\STOP sebelum bot mati,
REM                       atau jawab N saat ditanya.
REM ============================================================

set "PORT=8080"
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo ============================================================
echo  GetEmbassy Bot - lokal
echo  Port   : %PORT%
echo  Log    : %~dp0logs\bot.log
echo  Stop   : Ctrl+C, lalu jawab N
echo ============================================================
echo.

REM ===== Cegah 2 instance (PTB getUpdates hanya boleh 1 proses) =====
REM Dicek DULUAN: rotasi log harusnya tidak jalan kalau ternyata bot sudah hidup,
REM karena file log sedang dipegang proses itu dan move akan gagal diam-diam.
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2).StatusCode } catch { 0 }" >"%TEMP%\ge_bot_health" 2>nul
set /p HEALTH=<"%TEMP%\ge_bot_health"
del "%TEMP%\ge_bot_health" >nul 2>nul

if "!HEALTH!"=="200" (
    echo [ERROR] Bot sudah jalan di port %PORT%.
    echo         Tutup jendela/proses bot yang sedang berjalan, lalu jalankan lagi.
    echo.
    pause
    exit /b 1
)

REM ===== Rotasi log (simpan 2 generasi: bot.log + bot-prev.log) =====
if exist "logs\bot.log" (
    if exist "logs\bot-prev.log" del /q "logs\bot-prev.log" >nul 2>nul
    move /y "logs\bot.log" "logs\bot-prev.log" >nul 2>nul
)

REM ===== Sentinel STOP dari sesi sebelumnya tidak berlaku lagi =====
if exist "logs\STOP" del /q "logs\STOP" >nul 2>nul

:LOOP
echo.
echo [!date! !time!] Bot start...
echo ------------------------------------------------------------
REM Output python ditampilkan di jendela ini dan disalin ke logs\bot.log
REM (Add-Content -Encoding UTF8 supaya emoji tidak rusak).
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { python bot.py 2>&1 | ForEach-Object { $_; Add-Content -Path 'logs\bot.log' -Value $_ -Encoding UTF8 } }"
echo ------------------------------------------------------------
echo [!date! !time!] Bot berhenti.

if exist "logs\STOP" (
    del /q "logs\STOP" >nul 2>nul
    echo Sentinel logs\STOP ditemukan - bot tidak dijalankan ulang.
    goto BERHENTI
)

set /p "LANJUT=Jalankan ulang otomatis? (Y/N): "
if /i "!LANJUT!"=="N" goto BERHENTI
if /i "!LANJUT!"=="TIDAK" goto BERHENTI
echo Restart dalam 5 detik... (tekan Ctrl+C untuk membatalkan)
timeout /t 5 /nobreak >nul
goto LOOP

:BERHENTI
echo.
echo Bot GetEmbassy dihentikan.
pause
exit /b 0
