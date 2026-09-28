@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title GetEmbassy Bot

REM ============================================================
REM  GetEmbassy - Bot Telegram LOKAL
REM  Doibel-klik file ini untuk menjalankan bot.py.
REM
REM  - Bot dinyalakan ulang otomatis kalau crash / ditutup paksa
REM  - Semua output dicatat ke logs\bot.log
REM  - Menolak start kalau sudah ada bot yang jalan di port yang sama
REM
REM  Untuk berhenti: tutup jendela ini, atau Ctrl+C lalu Y.
REM ============================================================

set "PORT=8080"
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo ============================================================
echo  GetEmbassy Bot - lokal
echo  Port   : %PORT%
echo  Log    : %~dp0logs\bot.log
echo ============================================================
echo.

REM ===== Cegah 2 instance (PTB getUpdates hanya boleh 1 proses) =====
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

:LOOP
echo [!date! !time!] Bot start...
python bot.py >> "logs\bot.log" 2>&1
echo [!date! !time!] Bot berhenti. Restart dalam 5 detik...
timeout /t 5 /nobreak >nul
goto LOOP
