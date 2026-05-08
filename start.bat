@echo off
chcp 65001 >nul
title Instagram Automation - Operação

REM Garante que rodamos sempre no diretorio do proprio .bat
cd /d "%~dp0"

echo ========================================
echo  Subindo Instagram Automation
echo ========================================
echo.

REM Confirmar AdsPower rodando
echo [1/3] Verificando AdsPower...
curl -sf http://local.adspower.net:50325/status >nul 2>nul
if errorlevel 1 (
    echo [AVISO] AdsPower NAO respondeu em local.adspower.net:50325.
    echo Abra o aplicativo AdsPower e tente de novo.
    echo Se quiser continuar mesmo assim ^(modo somente painel^), tecle ENTER. Ctrl+C cancela.
    pause >nul
) else (
    echo [OK] AdsPower respondendo
)

echo.
echo [2/3] Verificando server\.env...
if not exist "server\.env" (
    echo [ERRO] server\.env nao existe. Rode install.bat primeiro.
    pause
    exit /b 1
)

echo.
echo [3/3] Subindo 3 processos (server, worker, client)...
echo Cada um abrira em uma janela separada. NAO feche durante a operacao.
echo.

REM Usa "start /D <pasta>" pra setar o working directory diretamente da janela nova.
REM Defesa contra path com espacos/acentos: o /D recebe o path absoluto do .bat (%~dp0).
start "Instagram Automation - SERVER" /D "%~dp0server" cmd /k "npx tsx --env-file=.env src/server.ts"
timeout /t 3 /nobreak >nul

start "Instagram Automation - WORKER" /D "%~dp0server" cmd /k "npx tsx --env-file=.env src/worker.ts"
timeout /t 2 /nobreak >nul

start "Instagram Automation - CLIENT" /D "%~dp0client" cmd /k "npm run dev"

echo.
echo ========================================
echo  Sistema iniciando...
echo ========================================
echo.
echo Aguarde 10-15 segundos e abra:
echo   http://localhost:3000
echo.
echo Login: admin@local
echo Senha: a definida no server\.env
echo.
echo Para PARAR, feche as 3 janelas que foram abertas.
echo.
pause