@echo off
title Instagram Automation - Diagnostico

set OUT=%USERPROFILE%\automacao-diagnostico.txt

echo Coletando informacoes pra mandar pro Eduardo...
echo.

echo === DIAGNOSTICO Instagram Automation === > "%OUT%"
echo Gerado em: %DATE% %TIME% >> "%OUT%"
echo Usuario: %USERNAME% >> "%OUT%"
echo Pasta usuario: %USERPROFILE% >> "%OUT%"
echo. >> "%OUT%"

echo === SISTEMA OPERACIONAL === >> "%OUT%"
ver >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === NODE.JS === >> "%OUT%"
where node >> "%OUT%" 2>&1
node --version >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === NPM === >> "%OUT%"
where npm >> "%OUT%" 2>&1
npm --version >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === GIT === >> "%OUT%"
where git >> "%OUT%" 2>&1
git --version >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === PASTA AUTOMACAO === >> "%OUT%"
if exist "%USERPROFILE%\automacao" (
    echo Existe: %USERPROFILE%\automacao >> "%OUT%"
    echo Conteudo: >> "%OUT%"
    dir "%USERPROFILE%\automacao" /b >> "%OUT%" 2>&1
    echo. >> "%OUT%"
    echo Arquivo .env existe? >> "%OUT%"
    if exist "%USERPROFILE%\automacao\server\.env" (
        echo SIM >> "%OUT%"
    ) else (
        echo NAO >> "%OUT%"
    )
    echo. >> "%OUT%"
    echo Banco SQLite existe? >> "%OUT%"
    if exist "%USERPROFILE%\automacao\server\prisma\dev.db" (
        echo SIM >> "%OUT%"
    ) else (
        echo NAO >> "%OUT%"
    )
    echo. >> "%OUT%"
    echo node_modules existe? >> "%OUT%"
    if exist "%USERPROFILE%\automacao\node_modules" (
        echo SIM >> "%OUT%"
    ) else (
        echo NAO >> "%OUT%"
    )
) else (
    echo NAO existe pasta %USERPROFILE%\automacao >> "%OUT%"
)
echo. >> "%OUT%"

echo === LOG DE INSTALACAO === >> "%OUT%"
if exist "%USERPROFILE%\automacao-instalacao.log" (
    echo Existe: %USERPROFILE%\automacao-instalacao.log >> "%OUT%"
    echo. >> "%OUT%"
    echo --- ULTIMAS 50 LINHAS DO LOG --- >> "%OUT%"
    powershell -NoProfile -Command "Get-Content '%USERPROFILE%\automacao-instalacao.log' -Tail 50" >> "%OUT%" 2>&1
) else (
    echo Nao existe log de instalacao. INSTALAR.bat nao chegou a rodar. >> "%OUT%"
)
echo. >> "%OUT%"

echo === ADSPOWER === >> "%OUT%"
echo Tentando conectar em http://local.adspower.net:50325/status... >> "%OUT%"
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://local.adspower.net:50325/status' -UseBasicParsing -TimeoutSec 5).Content } catch { 'AdsPower nao respondeu: ' + $_.Exception.Message }" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === PORTAS === >> "%OUT%"
echo Porta 3000 ^(painel^): >> "%OUT%"
netstat -ano | findstr :3000 >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo Porta 3010 ^(API^): >> "%OUT%"
netstat -ano | findstr :3010 >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo === Diagnostico salvo === >> "%OUT%"
echo.
echo ===========================================
echo   Diagnostico salvo em:
echo   %OUT%
echo ===========================================
echo.
echo PROXIMO PASSO: manda esse arquivo no zap pro Eduardo.
echo.
echo Quer ja abrir o arquivo agora? Aperte qualquer tecla.
pause >nul
notepad "%OUT%"