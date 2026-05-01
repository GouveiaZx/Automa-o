# 📦 Setup na máquina do cliente — Modo Real (Windows)

Roteiro definitivo para instalar e operar o sistema em produção.

---

## ⚠️ Antes de começar — leia isto

| Item | Detalhe |
|---|---|
| **AdsPower plano pago** | A versão GRÁTIS limita ~5 aberturas/dia. Para 10+ contas postando várias vezes/dia, **plano pago é obrigatório**. |
| **Story 24h via Web** | O Instagram Web em conta nova **não expõe** criador de Story. O sistema posta como **POST permanente no feed**. Story de fato só via mobile/app. |
| **Link na caption** | IG não permite link clicável. O sistema concatena o link no fim da caption (`🔗 https://...`) — operadores instruem público "copia o link da bio". |
| **Reel exige MP4** | h264, vertical 9:16 recomendado. JPG vira post regular. |
| **Pré-config do perfil** | Cliente loga IG no AdsPower **manualmente uma vez** (com 2FA), aceita pop-ups Meta de consentimento, configura nome/bio. Sistema não automatiza isso. |

---

## 1. Pré-requisitos

- ✅ Windows 10/11
- ✅ AdsPower instalado e **rodando** (PLANO PAGO recomendado para 10+ contas)
- ✅ Pelo menos 1 perfil AdsPower com Instagram **logado** + nome/bio configurado
- ✅ Conexão de internet estável

---

## 2. Instalar Node.js

1. Baixar: <https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi>
2. Instalar (next, next, next)
3. Abrir um **PowerShell** novo e confirmar:

```powershell
node --version    # v20.x.x
npm --version     # 10.x.x
```

---

## 3. Instalar Git

Baixar: <https://git-scm.com/download/win>
Instalar (next, next, next — opções padrão).

Confirmar:
```powershell
git --version    # 2.x.x
```

## 4. Clonar o sistema do GitHub

Abrir PowerShell:

```powershell
cd C:\
git clone https://github.com/GouveiaZx/Automa-o.git automacao
cd automacao
.\install.bat
```

O `install.bat` faz tudo:
- `npm install` (todas as deps, ~3 min)
- `npx playwright install chromium` (browser de automação, ~2 min)
- Cria `server\.env` se não existir
- `npm run db:migrate` (cria SQLite)
- `npm run db:seed` (admin + campanha exemplo)

Se der erro, **tira print do terminal e manda pro Eduardo**.

---

## 4. Configurar .env (uma vez só)

Editar `server\.env` com Notepad:

```env
AUTOMATION_MODE=real
JWT_SECRET=cole-aqui-uma-string-aleatoria-de-no-minimo-16-caracteres
ADMIN_BOOTSTRAP_PASSWORD=trocar-para-senha-forte
ADSPOWER_API_KEY=cole-aqui-se-AdsPower-pediu-no-painel-API
```

Os outros campos podem ficar como vieram.

---

## 5. Diagnóstico inicial (validar setup)

Confirmar que AdsPower está rodando:
- Abrir <http://local.adspower.net:50325/status> no navegador → deve retornar JSON com `code: 0`

Se der erro de conexão: abre o aplicativo AdsPower e tenta de novo.

---

## 6. Subir o sistema (operação diária)

```powershell
.\start.bat
```

3 janelas vão abrir (server, worker, client) — **deixa todas abertas** durante a operação.

Quando ver `Server listening at http://0.0.0.0:3010` e `client started on :3000`, pronto.

Acesse: **<http://localhost:3000>**
- E-mail: `admin@local`
- Senha: a que está no `.env`

---

## 7. Cadastro inicial pelo painel (uma vez)

### a) Diagnóstico (top do menu)
Clica **Recarregar**. Deve aparecer:
- ✓ AdsPower API conectado, com lista dos perfis disponíveis
- ✓ Playwright modo real

Se aparecer ⚠️ "Limite diário..." → você está no AdsPower grátis e bateu o cap. Aguarde 24h ou ative plano pago.

### b) Campanhas
Editar a "Campanha de Exemplo" (ou criar nova) com:
- Janela de horário (ex: 08:00–22:00)
- Intervalo mínimo/máximo entre posts
- Stories e reels por dia

### c) Perfis AdsPower
**Novo perfil** → cole o `user_id` real do AdsPower (coluna ID na lista do AdsPower) + um nome de referência.

### d) Contas Instagram
**Nova conta** → username (sem @), bio, **Site** (URL clicável), vincula com a campanha + perfil AdsPower.

> 💡 O campo **Site** é o link clicável que aparece no perfil IG (não na caption do post). Tipicamente é o `linktr.ee` / `bio.link` / `bioexclusiva` da modelo.

### d.1) Sincronizar bio + site no IG (atualiza o perfil real)
Na lista de contas, ao lado dos botões Play/Pause/Lixeira, há um **🔄 (Sincronizar)**. Clicando nele, o sistema:
1. Abre o perfil no AdsPower
2. Vai em "Editar perfil" do IG
3. Atualiza o campo Bio + campo Site com o que está cadastrado
4. Salva e fecha

Útil pra atualizar bio/site de várias contas em sequência sem ter que abrir cada uma manualmente.

### e) Diagnóstico → Testar perfil
Clica **Testar** em cada perfil. O AdsPower vai abrir, navegar pro IG e checar se está logado (~25s). Resultado esperado: `logado ✓`.

⚠️ Se aparecer **NÃO logado**:
- Abra o perfil manualmente no AdsPower
- Faça login no IG (com 2FA)
- Complete telas de consentimento Meta (LGPD)
- Feche o navegador
- Volte aqui e clica Testar de novo

---

## 8. Validação progressiva (Etapa 4 do `Inicio.md`)

Vá em **Configurações** → ajuste `MAX_ACTIVE_ACCOUNTS`:

```
1 conta  → testa por 24h. Confirma 1 post sem erro.
3 contas → testa por 24h.
7 contas → testa por 24h.
10 contas → testa por 48h.
20 contas → produção.
```

Worker reflete em ~5s após salvar.

---

## 9. Operação diária

1. **Subir mídia**: Mídia → Upload (mp4 ou jpg). Adicionar caption + link (se for "story"). Vincular com campanha.

2. **Agendar**: 
   - 1 a 1: Fila de jobs → "Agendar postagem" → escolhe conta + mídia → cria
   - Em lote: "Agendar lote" → escolhe conta + várias mídias + distribuição (now / 1h / hoje / 24h)

3. **Acompanhar**: 
   - Dashboard mostra timeline de hoje + alertas
   - Logs mostra cada passo do worker em tempo real
   - Quando uma conta falhar 2x → vira `paused` + alerta sonoro
   - Reativar: Contas → botão Play (▶)

---

## 11. Atualização (quando Eduardo mandar versão nova)

```powershell
cd C:\automacao
.\update.bat
```

O script:
- Faz `git pull origin main` (puxa nova versão do GitHub)
- Roda `npm install` (atualiza deps se mudou)
- Aplica novas migrations no banco
- Te pede pra rodar `start.bat` de novo

---

## Solução de problemas

| Sintoma | Solução |
|---|---|
| `EADDRINUSE :3010` | Outro app usando porta. Trocar `PORT=3011` no `server\.env` |
| Diagnóstico: "Cannot find Chromium" | `cd server && npx playwright install chromium` |
| Diagnóstico: "Falha ao conectar em http://localhost:50325" | AdsPower fechado. Abrir o aplicativo. |
| Diagnóstico: "Daily limit" | Plano grátis bateu cota. Aguardar 24h ou usar plano pago. |
| Conta vira `paused` repetidamente | Verificar se IG não pediu nova verificação. Abrir perfil manualmente, resolver, reativar pelo painel. |
| Job fica em "running" eternamente | Worker travou. Fechar a janela do worker e rodar `npm run dev:worker` no `server\` |
| Painel mostra erro 401 | Token expirou. Logout e login de novo. |

---

## Backup do banco

`server\prisma\dev.db` é o SQLite. Pra backup, basta copiar esse arquivo. Sistema todo pode ser reinstalado em outra máquina e o DB volta intacto.

---

## Suporte

Quando algo der errado:
1. Abre **Logs** no painel → copia as últimas linhas com erro
2. Se der erro visual durante automação: vai em `server\media\debug\` e pega os PNG mais recentes
3. Manda tudo pro Eduardo
