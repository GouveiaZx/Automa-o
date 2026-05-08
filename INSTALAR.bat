@echo off
title Instagram Automation - Instalador

REM ===========================================================
REM   ATENCAO EDUARDO: antes de mandar pro cliente, troque a
REM   URL abaixo pela URL com seu Personal Access Token (PAT).
REM   Formato esperado:
REM   https://x-access-token:SEU_TOKEN@github.com/GouveiaZx/Automa-o.git
REM ===========================================================
set REPO_URL=https://x-access-token:COLE_SEU_TOKEN_AQUI@github.com/GouveiaZx/Automa-o.git

REM Pasta destino: C:\Users\<usuario>\automacao
set DEST=%USERPROFILE%\automacao

REM Arquivo de log (cliente manda pro Edu se der erro)
set LOG=%USERPROFILE%\automacao-instalacao.log

echo. > "%LOG%"
echo Instalacao iniciada em: %DATE% %TIME% >> "%LOG%"
echo Usuario: %USERNAME% >> "%LOG%"
echo Pasta destino: %DEST% >> "%LOG%"
echo URL: %REPO_URL% >> "%LOG%"
echo. >> "%LOG%"

echo.
echo ============================================
echo   Instagram Automation - Instalador
echo ============================================
echo.
echo Esse instalador vai:
echo   1) Verificar se voce tem Node.js e Git
echo   2) Baixar o sistema
echo   3) Instalar componentes
echo   4) Configurar
echo   5) Abrir o sistema
echo.
echo Tudo vai ser salvo em: %DEST%
echo Log: %LOG%
echo.
echo Aperte qualquer tecla pra comecar.
pause >nul

REM --- VALIDACAO DE URL --------------------------------------
if "%REPO_URL:COLE_SEU_TOKEN_AQUI=%" NEQ "%REPO_URL%" (
    echo.
    echo [ERRO] O Eduardo esqueceu de colocar o token nesse instalador.
    echo Pede pra ele te mandar a versao correta do INSTALAR.bat.
    echo.
    echo [ERRO] Token nao foi configurado >> "%LOG%"
    pause
    exit /b 1
)

REM --- 1) Node.js --------------------------------------------
echo.
echo [1/5] Verificando Node.js...
echo [1/5] Verificando Node.js >> "%LOG%"
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [FALTA] Node.js nao esta instalado.
    echo.
    echo Vou abrir a pagina de download. Instale ^(next, next, next^),
    echo depois feche essa janela e clique 2x no INSTALAR.bat de novo.
    echo.
    echo [FALTA] Node.js nao instalado >> "%LOG%"
    start https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
    pause
    exit /b 1
)
node --version > "%TEMP%\nodever.txt" 2>&1
set /p NODE_VER=<"%TEMP%\nodever.txt"
echo   OK Node.js %NODE_VER%
echo   OK Node.js %NODE_VER% >> "%LOG%"

REM --- 2) Git ------------------------------------------------
echo.
echo [2/5] Verificando Git...
echo [2/5] Verificando Git >> "%LOG%"
where git >nul 2>nul
if errorlevel 1 (
    echo.
    echo [FALTA] Git nao esta instalado.
    echo.
    echo Vou abrir a pagina de download. Instale ^(next, next, next, deixe tudo padrao^),
    echo depois feche essa janela e clique 2x no INSTALAR.bat de novo.
    echo.
    echo [FALTA] Git nao instalado >> "%LOG%"
    start https://git-scm.com/download/win
    pause
    exit /b 1
)
git --version > "%TEMP%\gitver.txt" 2>&1
set /p GIT_VER=<"%TEMP%\gitver.txt"
echo   OK %GIT_VER%
echo   OK %GIT_VER% >> "%LOG%"

REM --- 3) Clone do GitHub ------------------------------------
echo.
echo [3/5] Baixando o sistema do GitHub...
echo [3/5] Clone do GitHub >> "%LOG%"

if exist "%DEST%" (
    echo.
    echo Pasta %DEST% ja existe. Vou tentar atualizar.
    echo Pasta ja existe, atualizando >> "%LOG%"
    cd /d "%DEST%"
    git pull origin main >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo.
        echo [ERRO] git pull falhou. Veja o detalhe em %LOG% e mande pro Eduardo.
        echo.
        echo [ERRO] git pull falhou >> "%LOG%"
        pause
        exit /b 1
    )
) else (
    git clone "%REPO_URL%" "%DEST%" >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo.
        echo [ERRO] Nao consegui baixar do GitHub.
        echo Veja o detalhe em %LOG% e mande pro Eduardo.
        echo.
        echo [ERRO] git clone falhou >> "%LOG%"
        pause
        exit /b 1
    )
    cd /d "%DEST%"
)
echo   OK baixado em %DEST%
echo   OK baixado >> "%LOG%"

REM --- 4) Instalar dependencias ------------------------------
echo.
echo [4/5] Instalando componentes ^(pode levar 5-10 min^)...
echo Nao feche a janela. Voce vai ver muito texto, eh normal.
echo [4/5] npm install >> "%LOG%"
call npm install >> "%LOG%" 2>&1
if errorlevel 1 (
    echo.
    echo [ERRO] Instalacao de componentes falhou.
    echo Veja %LOG% e mande pro Eduardo.
    echo.
    echo [ERRO] npm install falhou >> "%LOG%"
    pause
    exit /b 1
)

echo.
echo Baixando navegador interno do Playwright ^(~150MB^)...
echo Playwright chromium install >> "%LOG%"
pushd server
call npx playwright install chromium >> "%LOG%" 2>&1
popd

echo   OK componentes instalados
echo   OK componentes >> "%LOG%"

REM --- 5) Configurar .env e banco ----------------------------
echo.
echo [5/5] Configurando arquivo de configuracao e banco de dados...
echo [5/5] Configurando .env >> "%LOG%"

REM Copia .env.example pra .env se nao existir (o .env.example ja vem com defaults seguros)
if not exist "server\.env" (
    copy "server\.env.example" "server\.env" >nul
    echo .env criado a partir do .env.example >> "%LOG%"
)

REM Garante AUTOMATION_MODE=real (substitui se estava mock)
powershell -NoProfile -Command "(Get-Content 'server\.env') -replace '^AUTOMATION_MODE=.*', 'AUTOMATION_MODE=real' | Set-Content 'server\.env'" >> "%LOG%" 2>&1

REM Cria banco SQLite e seeds
call npm run db:migrate >> "%LOG%" 2>&1
call npm run db:seed >> "%LOG%" 2>&1
echo   OK configuracao + banco
echo   OK configuracao + banco >> "%LOG%"

REM --- Atalho na area de trabalho pro start.bat --------------
echo.
echo Criando atalho na area de trabalho...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Instagram Automation.lnk');$s.TargetPath='%DEST%\start.bat';$s.WorkingDirectory='%DEST%';$s.IconLocation='%SystemRoot%\System32\shell32.dll,13';$s.Save()" >> "%LOG%" 2>&1

REM --- Final -------------------------------------------------
echo.
echo ============================================
echo   INSTALACAO CONCLUIDA!
echo ============================================
echo.
echo Sistema instalado em: %DEST%
echo Atalho criado: Area de Trabalho - "Instagram Automation"
echo.
echo CREDENCIAIS DE ACESSO:
echo   URL:     http://localhost:3000
echo   Email:   admin@local
echo   Senha:   admin123    ^(MUDE depois no painel se quiser^)
echo.
echo COMO USAR TODO DIA:
echo   1) Abra o AdsPower
echo   2) Clique no atalho "Instagram Automation" na Area de Trabalho
echo   3) Aguarde 15 segundos e abra: http://localhost:3000
echo.
echo Quer ja iniciar o sistema agora? ^(S/N^)
set /p START_NOW="Sua resposta: "

if /i "%START_NOW%"=="S" (
    echo.
    echo Iniciando sistema...
    cd /d "%DEST%"
    start "" "%DEST%\start.bat"
    timeout /t 5 /nobreak >nul
    echo Aguarde 15 segundos e abra: http://localhost:3000
    timeout /t 10 /nobreak >nul
    start http://localhost:3000
)

echo.
echo Instalacao terminou em: %DATE% %TIME% >> "%LOG%"
echo.
echo Pronto! Aperte qualquer tecla pra fechar essa janela.
pause >nul