# 🚀 Roteiro de entrega — Eduardo → cliente (Gustavo)

Esse doc é **só pra você (Eduardo)**. Cliente recebe o `MENSAGEM_GUSTAVO.md` + `INSTALAR.bat`.

---

## 🔑 ANTES DE TUDO — Gerar o PAT (token de acesso ao repo privado)

Como o repo `GouveiaZx/Automa-o` é privado, o Gustavo precisa de um **token** pra clonar. Você gera 1 vez e embute na URL.

### Passo a passo

1. Vai em <https://github.com/settings/personal-access-tokens/new> (Fine-grained tokens)
2. Preenche:
   - **Token name**: `gustavo-automacao-deploy`
   - **Expiration**: `90 days` (renovável)
   - **Repository access**: `Only select repositories` → escolhe `GouveiaZx/Automa-o`
   - **Permissions** → Repository permissions:
     - **Contents**: `Read-only`
     - **Metadata**: `Read-only` (já vem)
   - Salva
3. Copia o token (começa com `github_pat_...` ou `ghp_...`). **Anota num lugar seguro** — só dá pra ver agora.
4. **A URL secreta** que você vai mandar pro Gustavo é:
   ```
   https://x-access-token:SEU_TOKEN_AQUI@github.com/GouveiaZx/Automa-o.git
   ```
   Substitui `SEU_TOKEN_AQUI` pelo token copiado.

### Exemplo (com token fake só pra ilustrar)

```
https://x-access-token:github_pat_11ABCDEFG_xxxx@github.com/GouveiaZx/Automa-o.git
```

> ⚠️ **Não compartilhe esse token publicamente.** Mande pro Gustavo no WhatsApp privado e peça pra ele não passar pra ninguém. Se vazar, você revoga em <https://github.com/settings/personal-access-tokens> e gera outro.

---

## 📩 O que mandar pro Gustavo no zap

Manda 3 mensagens separadas:

### Mensagem 1 — Anexo
- Arquivo: **`INSTALAR.bat`** (está na raiz do projeto, manda como anexo)

### Mensagem 2 — A URL secreta
```
URL pra colar no instalador (NÃO compartilha com ninguém):

https://x-access-token:SEU_TOKEN_AQUI@github.com/GouveiaZx/Automa-o.git
```

### Mensagem 3 — O passo a passo
Cola o conteúdo do **`MENSAGEM_GUSTAVO.md`** (versão pronta com tudo bem mastigado).

---

## Cenário A — Você instala remotamente (recomendado)

Você usa AnyDesk/TeamViewer pra entrar na máquina do cliente e configura tudo.

### Passo 1 — Preparar o pacote local (você, antes de entrar)

Na sua máquina, na pasta do projeto:

```powershell
# Limpar artefatos pesados que serão regerados na máquina do cliente
Remove-Item -Recurse -Force node_modules, .next, dist, server\dist, client\.next -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force server\node_modules, client\node_modules, shared\node_modules -ErrorAction SilentlyContinue
# Manter prisma\dev.db zerado pra cliente
Remove-Item server\prisma\dev.db, server\prisma\dev.db-journal -ErrorAction SilentlyContinue
# Limpar mídia de teste
Remove-Item -Recurse -Force server\media\debug -ErrorAction SilentlyContinue
Get-ChildItem server\media -Filter "*.mp4","*.jpg","*.png" -ErrorAction SilentlyContinue | Remove-Item
```

Compactar a pasta inteira em `automacao-cliente.zip` (~5MB sem node_modules).

### Passo 2 — Na máquina do cliente

1. **Verificar AdsPower**: abrir o aplicativo, confirmar que tem o plano pago (ou no mínimo plano que aceite N perfis)
2. Confirmar que o cliente já tem 1+ perfil com IG logado manualmente
3. Pedir os `user_id` dos perfis (coluna ID no AdsPower)

### Passo 3 — Instalar Node.js (se não tiver)

<https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi>

### Passo 4 — Extrair zip e rodar install

```powershell
cd C:\automacao-instagram
.\install.bat
```

(~5 min). Confere mensagem "Instalacao concluida".

### Passo 5 — Editar `server\.env`

```env
AUTOMATION_MODE=real
JWT_SECRET=<string-aleatoria-32-chars>
ADMIN_BOOTSTRAP_PASSWORD=<senha-pro-cliente>
```

Anote a senha.

### Passo 6 — Subir e validar

```powershell
.\start.bat
```

Acessa <http://localhost:3000>, login admin@local + senha do .env.

Diagnóstico → "Recarregar" → deve listar perfis AdsPower.

Cadastrar 1 perfil real + 1 conta IG vinculada.

Diagnóstico → "Testar" no perfil → `logado ✓`.

### Passo 7 — Smoke test com 1 mídia real

Pedir 1 mp4 ou jpg do cliente. Upload via Mídia. Agendar via Fila de jobs.

Acompanhar nos Logs. Quando ver `done`, abrir o IG no AdsPower e confirmar que o post apareceu.

### Passo 8 — Validação progressiva

`Configurações` → `MAX_ACTIVE_ACCOUNTS=1` → cliente opera 24h.

Você acompanha remoto. Se OK, sobe pra 3, 7, 10, 20.

### Passo 9 — Entregar credenciais

Anota num doc no Notion/papel:
- URL do painel: <http://localhost:3000>
- Login: admin@local
- Senha: <a definida>
- Como subir: `start.bat`
- Como atualizar: `update.bat` (manda zip novo, extrai por cima)

---

## Cenário B — Cliente instala sozinho (zip + instruções)

Manda o zip + o `SETUP_CLIENTE.md` por e-mail/Drive.

Cliente:
1. Lê `SETUP_CLIENTE.md`
2. Instala Node.js
3. Extrai zip
4. Edita `server\.env`
5. Roda `install.bat`
6. Roda `start.bat`

**Você fica disponível no WhatsApp** pra resolver problemas que aparecerem.

---

## Cenário C — Você roda 100% local na sua máquina, cliente acessa via rede

Se o cliente confiar em você operar:
- Sistema fica na sua máquina
- Edita `server\.env`: `HOST=0.0.0.0` (já é) e abre porta 3010 no firewall
- Cliente acessa `http://<seu-ip-publico>:3000` (precisa expor com Cloudflare Tunnel ou ngrok)

**Não recomendo pra MVP** — adiciona complexidade de rede. Cenário A é mais limpo.

---

## Checklist final antes de entregar

- [ ] `npm run typecheck` passa em todos os workspaces
- [ ] `npm run build` gera dist sem erro
- [ ] `server\.env.example` tem todas as variáveis documentadas
- [ ] `SETUP_CLIENTE.md` atualizado
- [ ] `install.bat`, `start.bat`, `update.bat` testados na sua máquina
- [ ] AdsPower do cliente: plano confirmado (paido se 10+ contas)
- [ ] Cliente tem 1+ perfil com IG logado manualmente
- [ ] Backup combinado: cliente sabe que `server\prisma\dev.db` é o banco e pode ser copiado pra backup

---

## Pós-entrega — suporte

Cliente vai te contatar quando:
- IG mudar layout (selectors quebram) → ele te manda PNG de `server\media\debug\*.png`
- Conta vai pra `paused` repetidamente → IG pode ter pedido nova verificação
- Sistema travou → fechar 3 janelas e rodar `start.bat` de novo

Manter um chat ativo com cliente nos primeiros dias é normal.

---

## Coisas que o cliente NÃO vai conseguir resolver sozinho (sua responsabilidade)

| Problema | Solução |
|---|---|
| Selectors do IG quebraram | Você atualiza `server\src\automation\real-driver.ts` e manda zip novo + `update.bat` |
| Bug no painel | Você corrige + manda update |
| Quer feature nova | Você desenvolve + manda update |

---

## Versionamento

Sugestão: a cada update, criar uma tag/versão no `package.json` raiz e mandar no chat:
```
v1.2.0 - Correção do botão Compartilhar
```

Cliente extrai zip novo por cima e roda `update.bat`.
