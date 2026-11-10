@echo off
setlocal
cd /d "%~dp0"
chcp 65001 > nul
title CYBERPOLIS - Silverbot2 // Unix

echo =======================================================
echo   🛡️ CYBERPOLIS // SILVERBOT2 & UNIX
echo   Intel en Hacking & Politica
echo =======================================================
echo.
echo  Selecciona como deseas ejecutar:
echo.
echo  [1] Modo Servidor Local (Recomendado - Auto-abre navegador)
echo  [2] Modo Directo Navegador (Sin servidor, doble clic rapido)
echo  [3] Salir
echo.
set /p opt="Elige opcion [1, 2 o 3] (por defecto 1): "

if "%opt%"=="" set opt=1

if "%opt%"=="1" (
    echo.
    echo Iniciando servidor Node.js y abriendo navegador...
    node server.js
    pause
    exit
)

if "%opt%"=="2" (
    echo.
    echo Abriendo portal en tu navegador...
    start "" "%~dp0index.html"
    exit
)

if "%opt%"=="3" (
    exit
)

echo Opción desconocida, abriendo navegador...
start "" "%~dp0index.html"
