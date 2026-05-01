@echo off
chcp 65001 >nul
title Instagram Automation - Atualização

echo ========================================
echo  Atualizando Instagram Automation
echo ========================================
echo.
echo Antes de continuar:
echo  1. Feche as 3 janelas (server, worker, client) abertas
echo.
pause

echo.
echo [1/4] Puxando nova versao do GitHub...
git pull origin main
if errorlevel 1 (
    echo [AVISO] git pull falhou. Pode ser conflito local.
    echo Se voce nao mudou nada manualmente, rode:
    echo   git reset --hard origin/main
    pause
    exit /b 1
)

echo.
echo [2/4] Atualizando dependencias...
call npm install
if errorlevel 1 (
    echo [ERRO] npm install falhou.
    pause
    exit /b 1
)

echo.
echo [3/4] Aplicando migrations do banco (se houver)...
call npm run db:migrate
if errorlevel 1 (
    echo [AVISO] db:migrate retornou erro.
)

echo.
echo [4/4] Verificando build...
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
