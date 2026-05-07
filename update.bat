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
echo [1/6] Matando processos node antigos pra liberar arquivos...
REM Mata todos node.exe pra evitar EPERM no prisma generate (query_engine.dll travado)
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>nul
timeout /t 2 /nobreak >nul

echo.
echo [2/6] Puxando nova versao do GitHub...
REM Defesa: se git pull der conflito (ex: update.bat local modificado por RESOLVER),
REM faz reset --hard pra forcar atualizacao. PC do cliente nao tem mudancas locais
REM que precise preservar — qualquer divergencia local eh lixo de instalacao anterior.
git fetch origin main
if errorlevel 1 (
    echo [ERRO] git fetch falhou. Sem internet ou repo travado. Me chama pelo Workana.
    pause
    exit /b 1
)
git reset --hard origin/main
if errorlevel 1 (
    echo [ERRO] git reset falhou. Me chama pelo Workana.
    pause
    exit /b 1
)

echo.
echo [3/6] Atualizando dependencias...
call npm install
if errorlevel 1 (
    echo [ERRO] npm install falhou.
    pause
    exit /b 1
)

echo.
echo [4/6] Regenerando Prisma Client (essencial apos schema novo)...
pushd server
call npx prisma generate
if errorlevel 1 (
    echo [ERRO] prisma generate falhou.
    echo Feche TODAS as janelas pretas (server, worker, client) e rode update.bat de novo.
    popd
    pause
    exit /b 1
)
popd

echo.
echo [5/6] Aplicando migrations do banco (se houver)...
call npm run db:migrate
if errorlevel 1 (
    echo [AVISO] db:migrate retornou erro.
)

echo.
echo [6/6] Verificando build...
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
