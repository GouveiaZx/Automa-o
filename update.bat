@echo off
chcp 65001 >nul
title Instagram Automation - Atualização

REM Garante que rodamos sempre no diretorio do proprio .bat
cd /d "%~dp0"

echo ========================================
echo  Atualizando Instagram Automation
echo ========================================
echo.
echo Antes de continuar:
echo  1. Feche as 3 janelas (server, worker, client) abertas
echo.
pause

echo.
echo [1/5] Matando processos node antigos pra liberar arquivos...
REM Mata todos node.exe pra evitar EPERM no prisma generate (query_engine.dll travado)
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>nul
timeout /t 2 /nobreak >nul

echo.
echo [2/5] Puxando nova versao do GitHub...
git pull origin main
if errorlevel 1 (
    echo [AVISO] git pull falhou. Pode ser conflito local.
    echo Se voce nao mudou nada manualmente, rode:
    echo   git reset --hard origin/main
    pause
    exit /b 1
)

echo.
echo [3/5] Atualizando dependencias...
call npm install
if errorlevel 1 (
    echo [ERRO] npm install falhou.
    pause
    exit /b 1
)

echo.
echo [4/5] Aplicando migrations do banco (se houver)...
call npm run db:migrate
if errorlevel 1 (
    echo [AVISO] db:migrate retornou erro.
)

echo.
echo [5/5] Verificando build...
call npm run typecheck --workspaces --if-present
if errorlevel 1 (
    echo [AVISO] typecheck retornou erro. Pode haver problemas.
)

echo.
echo ========================================
echo  Atualizacao concluida!
echo ========================================
echo.
echo Rode .\start.bat para subir o sistema novamente.
echo.
pause
