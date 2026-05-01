@echo off
chcp 65001 >nul
title Instagram Automation - Instalação

echo ========================================
echo  Instagram Automation - Setup inicial
echo ========================================
echo.

REM Verificar Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado.
    echo Baixe em: https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
    echo Instale e rode novamente este script.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

echo.
echo [1/5] Instalando dependencias do projeto (~3 min)...
call npm install
if errorlevel 1 (
    echo [ERRO] npm install falhou.
    pause
    exit /b 1
)

echo.
echo [2/5] Baixando Chromium para automacao (~150MB, ~2 min)...
pushd server
call npx playwright install chromium
popd
if errorlevel 1 (
    echo [AVISO] Playwright install retornou erro. Pode precisar rodar manualmente.
)

echo.
echo [3/5] Configurando .env do server...
if not exist "server\.env" (
    copy "server\.env.example" "server\.env" >nul
    echo [OK] server\.env criado a partir do .env.example
    echo.
    echo ATENCAO: edite server\.env antes de rodar:
    echo   - JWT_SECRET (string aleatoria com 16+ chars)
    echo   - ADMIN_BOOTSTRAP_PASSWORD (sua senha de admin)
    echo   - AUTOMATION_MODE=real
) else (
    echo [OK] server\.env ja existe, mantendo
)

echo.
echo [4/5] Configurando .env.local do client...
if not exist "client\.env.local" (
    copy "client\.env.example" "client\.env.local" >nul
    echo [OK] client\.env.local criado
) else (
    echo [OK] client\.env.local ja existe, mantendo
)

echo.
echo [5/5] Migracao do banco SQLite + seed do admin...
call npm run db:migrate
if errorlevel 1 (
    echo [ERRO] db:migrate falhou. Verifique server\.env.
    pause
    exit /b 1
)
call npm run db:seed
if errorlevel 1 (
    echo [AVISO] db:seed falhou. Pode ser que o admin ja exista, ok.
)

echo.
echo ========================================
echo  Instalacao concluida!
echo ========================================
echo.
echo Proximos passos:
echo  1. Edite server\.env (JWT_SECRET, ADMIN_BOOTSTRAP_PASSWORD)
echo  2. Confirme que o AdsPower esta rodando
echo  3. Rode .\start.bat para subir o sistema
echo  4. Acesse http://localhost:3000
echo.
pause
