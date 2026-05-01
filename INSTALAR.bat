@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Instagram Automation - Instalador

echo.
echo ==========================================
echo   Instagram Automation - Instalador
echo ==========================================
echo.
echo Esse instalador vai:
echo   1. Verificar Node.js e Git
echo   2. Baixar o sistema do GitHub
echo   3. Instalar dependencias
echo   4. Configurar arquivo .env
echo   5. Criar banco de dados
echo.
echo Voce so precisa fazer 2 coisas:
echo   - Colar a URL do GitHub que o Eduardo te mandou
echo   - Definir uma senha de admin
echo.
pause

echo.
echo [1/6] Verificando Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERRO] Node.js NAO instalado.
    echo.
    echo Baixe e instale antes de continuar:
    echo   https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
    echo.
    echo Apos instalar, abra esse arquivo INSTALAR.bat de novo.
    echo.
    pause
    start https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Node.js %%v OK

echo.
echo [2/6] Verificando Git...
where git >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERRO] Git NAO instalado.
    echo.
    echo Baixe e instale antes de continuar:
    echo   https://git-scm.com/download/win
    echo.
    echo Apos instalar, abra esse arquivo INSTALAR.bat de novo.
    echo.
    pause
    start https://git-scm.com/download/win
    exit /b 1
)
for /f "tokens=*" %%v in ('git --version') do echo   %%v OK

echo.
echo [3/6] Cole a URL do GitHub que o Eduardo te mandou
echo (Algo como: https://x-access-token:ghp_xxxxx@github.com/GouveiaZx/Automa-o.git)
echo.
set /p REPO_URL="URL: "

if "%REPO_URL%"=="" (
    echo [ERRO] URL vazia. Saindo.
    pause
    exit /b 1
)

echo.
echo [4/6] Baixando o sistema do GitHub...

REM Pasta destino: C:\automacao na raiz, sem espacos/acentos
set DEST=%USERPROFILE%\automacao
if exist "%DEST%" (
    echo.
    echo [AVISO] A pasta %DEST% ja existe.
    echo Se quiser uma instalacao limpa, apague-a antes e rode esse instalador de novo.
    echo Senao, vou tentar atualizar essa instalacao existente.
    cd /d "%DEST%"
    git pull origin main
    if errorlevel 1 (
        echo [ERRO] git pull falhou. Apague %DEST% e tente novamente.
        pause
        exit /b 1
    )
) else (
    git clone "%REPO_URL%" "%DEST%"
    if errorlevel 1 (
        echo.
        echo [ERRO] Clone falhou. Confira:
        echo   - URL correta?
        echo   - Conexao com internet?
        echo   - Se o GitHub abriu janela de login, faca login com sua conta
        pause
        exit /b 1
    )
    cd /d "%DEST%"
)

echo.
echo [5/6] Instalando dependencias (~5 min, pode levar mais)...
call npm install
if errorlevel 1 (
    echo [ERRO] npm install falhou. Veja a mensagem acima e mande pro Eduardo.
    pause
    exit /b 1
)

echo.
echo Baixando Chromium do Playwright (~150MB)...
pushd server
call npx playwright install chromium
popd

echo.
echo [6/6] Configurando .env e banco de dados...

REM Cria server\.env se nao existir
if not exist "server\.env" (
    copy "server\.env.example" "server\.env" >nul

    REM Pede senha de admin
    echo.
    echo Defina uma senha pra acessar o painel admin (digite e tecle ENTER):
    set /p ADMIN_PWD="Senha de admin: "
    if "!ADMIN_PWD!"=="" set ADMIN_PWD=admin123

    REM Gera JWT_SECRET aleatorio (32 chars)
    set "CHARS=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    set "JWT_SECRET="
    for /l %%i in (1,1,32) do (
        set /a "rnd=!random! %% 62"
        for /f %%c in ('powershell -nop -c "Write-Host '!CHARS!'.Substring(!rnd!, 1) -NoNewLine"') do set "JWT_SECRET=!JWT_SECRET!%%c"
    )

    REM Substitui no .env (powershell pra evitar bagunca com chars especiais)
    powershell -nop -c "(Get-Content 'server\.env') -replace 'JWT_SECRET=.*', 'JWT_SECRET=\"!JWT_SECRET!\"' -replace 'ADMIN_BOOTSTRAP_PASSWORD=.*', 'ADMIN_BOOTSTRAP_PASSWORD=!ADMIN_PWD!' -replace 'AUTOMATION_MODE=mock', 'AUTOMATION_MODE=real' | Set-Content 'server\.env'"

    echo.
    echo .env configurado:
    echo   - JWT_SECRET: gerado automaticamente (32 chars)
    echo   - Admin: admin@local
    echo   - Senha: !ADMIN_PWD!
    echo   - Modo: real (AdsPower + Playwright)
)

REM Aplica migrations + seed
call npm run db:migrate
if errorlevel 1 (
    echo [AVISO] db:migrate retornou erro.
)
call npm run db:seed

echo.
echo ==========================================
echo   INSTALACAO CONCLUIDA!
echo ==========================================
echo.
echo O sistema foi instalado em:
echo   %DEST%
echo.
echo PARA USAR TODO DIA:
echo   1. Abra o AdsPower e deixe ele rodando
echo   2. Va na pasta %DEST%
echo   3. Clique 2x no arquivo "start.bat"
echo   4. Abra o navegador em: http://localhost:3000
echo   5. Login: admin@local / Senha: a que voce escolheu acima
echo.
echo PARA ATUALIZAR (quando o Eduardo te avisar):
echo   1. Feche as 3 janelas do sistema
echo   2. Va na pasta %DEST%
echo   3. Clique 2x no arquivo "update.bat"
echo.
echo Vou abrir a pasta agora pra voce ver:
echo.
pause
explorer "%DEST%"
