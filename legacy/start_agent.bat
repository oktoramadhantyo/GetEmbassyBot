@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title GetEmbassy Agent

REM ============================================================
REM  GetEmbassy - Agent lokal
REM  Doibel-klik file ini untuk:
REM    1) mencari chrome.exe secara otomatis
REM    2) membuka Chrome dengan remote debugging port 9222
REM       (profil terpisah di folder "chrome-profile")
REM    3) menjalankan python agent.py
REM ============================================================

set "PORT=9222"

REM ===== Deteksi lokasi chrome.exe =====
set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
    echo [ERROR] chrome.exe tidak ditemukan di lokasi umum.
    echo 1. Pastikan Chrome sudah terinstall: https://www.google.com/chrome/
    echo 2. Atau jalankan manual:
    echo    chrome.exe --remote-debugging-port=%PORT%
    pause
    exit /b 1
)

REM ===== Profil Chrome (follow folder file ini) =====
set "PROFIL=%~dp0chrome-profile"

echo ============================================================
echo  GetEmbassy Agent
echo  Chrome   : %CHROME%
echo  Profil   : %PROFIL%
echo ============================================================
echo.

REM ===== Cek apakah debug port sudah aktif =====
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/json/version' -TimeoutSec 2).StatusCode } catch { 0 }" >"%TEMP%\ge_port" 2>nul
set /p PORTSTATUS=<"%TEMP%\ge_port"
del "%TEMP%\ge_port" >nul 2>nul

if "!PORTSTATUS!"=="200" goto SUDAH_AKTIF

echo [INFO] Memulai Chrome dengan debug port %PORT% ...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFIL%"

set /a N=0
REM Tunggu sampai port aktif (maksimum 30 detik)
:TUNGGU
set /a N+=1
if !N! gtr 30 goto TUNGGU_SELESAI
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/json/version' -TimeoutSec 2).StatusCode } catch { 0 }" >"%TEMP%\ge_port" 2>nul
set /p PORTSTATUS=<"%TEMP%\ge_port"
del "%TEMP%\ge_port" >nul 2>nul
if not "!PORTSTATUS!"=="200" ( ping -n 2 127.0.0.1 >nul & goto TUNGGU )
:TUNGGU_SELESAI
if not "!PORTSTATUS!"=="200" goto WARING
goto SUDAH_AKTIF

:WARING
echo [WARN] Port debug belum terdeteksi setelah 30 detik.
echo 1. Tutup SEMUA jendela Chrome yang sedang terbuka, lalu jalankan file ini lagi.
echo 2. Pastikan tidak ada software yang memakai port %PORT%.
pause
goto LOGIN

:SUDAH_AKTIF
echo [INFO] Chrome debug aktif di port %PORT%.

:LOGIN
echo.
echo [PENTING] Di jendela Chrome yang baru terbuka:
echo   1. Login Gladius (kalau diminta).
echo   2. Buka halaman embassy:
echo      https://gladius.telkom.co.id/radonline/newradonline
echo   3. Biarkan tab embassy tetap terbuka.
echo.
echo Tekan tombol apa saja untuk melanjutkan menjalankan agent...
pause >nul

echo.
echo [INFO] Menjalankan agent ...
python agent.py
pause