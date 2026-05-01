@echo off
chcp 65001 >nul
title Instagram Automation - Operação

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

start "Instagram Automation - SERVER" cmd /k "cd server && npx tsx --env-file=.env src/server.ts"
timeout /t 3 /nobreak >nul

start "Instagram Automation - WORKER" cmd /k "cd server && npx tsx --env-file=.env src/worker.ts"
timeout /t 2 /nobreak >nul

start "Instagram Automation - CLIENT" cmd /k "cd client && npm run dev"

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
