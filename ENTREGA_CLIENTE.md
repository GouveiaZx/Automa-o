# 🚀 Roteiro de entrega — Eduardo → Gustavo

Esse doc é **só pra você (Eduardo)**. Cliente recebe `MENSAGEM_GUSTAVO.md` + `INSTALAR.bat` + `DIAGNOSTICAR.bat`.

---

## 🔑 ANTES DE TUDO — Customizar o `INSTALAR.bat` com seu token

O `INSTALAR.bat` no repo está com placeholder `COLE_SEU_TOKEN_AQUI`. Você precisa criar uma versão personalizada antes de mandar pro Gustavo.

### Passo 1 — Gerar PAT (Personal Access Token) no GitHub

1. Vai em <https://github.com/settings/personal-access-tokens/new> (Fine-grained tokens)
2. Preenche:
   - **Token name**: `gustavo-automacao-deploy`
   - **Expiration**: `90 days` (renovável)
   - **Repository access**: `Only select repositories` → escolhe `GouveiaZx/Automa-o`
   - **Permissions** → Repository permissions → **Contents**: `Read-only`
3. Clica **Generate token**
4. **Copia o token** (começa com `github_pat_...` ou `ghp_...`). Anota num lugar seguro — só dá pra ver agora.

### Passo 2 — Customizar `INSTALAR.bat`

Abre `INSTALAR.bat` no Notepad e troca a linha:

```bat
set REPO_URL=https://x-access-token:COLE_SEU_TOKEN_AQUI@github.com/GouveiaZx/Automa-o.git
```

por:

```bat
set REPO_URL=https://x-access-token:SEU_TOKEN_REAL_AQUI@github.com/GouveiaZx/Automa-o.git
```

Substitui `SEU_TOKEN_REAL_AQUI` pelo token que você copiou.

**Salva como `INSTALAR.bat` numa pasta separada** (ex: `C:\Users\GouveiaRx\Desktop\enviar-gustavo\`) — esse é o arquivo que vai pro Gustavo.

⚠️ **Não commite essa versão personalizada no repo.** Token é segredo.

---

## 📩 O que mandar pro Gustavo no zap

3 mensagens:

### Mensagem 1 — Anexos
- **`INSTALAR.bat`** (a versão personalizada com seu token)
- **`DIAGNOSTICAR.bat`** (cópia direta do repo)

### Mensagem 2 — Texto
Cola o conteúdo de `MENSAGEM_GUSTAVO.md` (o passo a passo dele).

### Mensagem 3 — Aviso opcional de segurança
> "Esses arquivos têm um token meu de acesso ao GitHub. Não compartilha com ninguém. Se você não usar mais o sistema, me avisa que eu cancelo o token."

---

## 🐛 Se o Gustavo der erro na instalação

1. Pede pra ele rodar **`DIAGNOSTICAR.bat`** (clique 2x)
2. Vai ser gerado `C:\Users\<usuario-dele>\automacao-diagnostico.txt`
3. Pede pra ele te mandar esse arquivo no zap
4. Com base nele, você identifica o problema:
   - Node.js / Git não instalados → manda link
   - Clone falhou → token expirou ou URL errada → gera novo PAT
   - npm install falhou → problema de rede / proxy / antivírus
   - Pasta `automacao` existe mas vazia → permissões / disk full
   - Etc.

5. Versão corrigida do INSTALAR.bat → manda novamente

---

## 🔄 Atualizando o sistema (workflow)

Você desenvolveu uma correção:

1. Edita o código local
2. `git commit -m "fix: ..."` + `git push origin main`
3. Avisa o Gustavo no zap: **"Versão nova subiu, roda update.bat"**
4. Ele vai na pasta `automacao` e clica 2x em `update.bat`
5. O `update.bat` faz `git pull origin main` (usando o token salvo no `.git/config` dele) + `npm install` + `db:migrate`

**Fluxo perfeito** — sem zip, sem reenvio de arquivo.

---

## 🔒 Quando o token expirar (90 dias)

1. Você gera novo PAT em <https://github.com/settings/personal-access-tokens>
2. Pede pro Gustavo abrir `C:\Users\<usuario>\automacao\.git\config` no Notepad
3. Procura a linha `url = https://x-access-token:TOKEN_VELHO@github.com/...`
4. Substitui `TOKEN_VELHO` pelo novo
5. Salva
6. Pronto, próximo `update.bat` funciona

OU mais simples:

1. Você gera novo PAT
2. Manda novo `INSTALAR.bat` personalizado
3. Pede pro Gustavo executar de novo (ele vai detectar pasta existe e fazer git pull, atualizando o remote)

---

## 📋 Checklist antes de mandar (primeira vez)

- [ ] PAT gerado no GitHub com escopo correto (`Contents: Read`, repo `Automa-o`)
- [ ] `INSTALAR.bat` editado com token real (NÃO commitar essa versão)
- [ ] `DIAGNOSTICAR.bat` separado pra mandar junto
- [ ] `MENSAGEM_GUSTAVO.md` lida e ajustada se quiser personalizar
- [ ] AdsPower do cliente: plano confirmado (pago se 10+ contas)
- [ ] Cliente vai logar IG manualmente nos perfis antes de testar
- [ ] Você disponível no zap nas próximas 24h pra suporte

---

## Pós-entrega — suporte

Cliente vai te contatar quando:
- IG mudar layout (selectors quebram) → ele te manda PNG de `server\media\debug\*.png`
- Conta vai pra `paused` repetidamente → IG pode ter pedido nova verificação
- Sistema travou → fechar 3 janelas e abrir o atalho "Instagram Automation" de novo

Manter um chat ativo com cliente nos primeiros dias é normal.

---

## 🔥 Limitações conhecidas (avise o cliente)

| Limitação | Workaround |
|---|---|
| AdsPower grátis = ~5 aberturas/dia | Plano pago obrigatório |
| Story 24h não funciona via Web em conta nova | Sistema posta como POST permanente; story real só via mobile |
| Caption não tem link clicável (limitação IG) | Sistema concatena link no fim da caption + atualiza bio |
| Reel exige MP4 vertical | Validar antes de subir |
| Tela LGPD do Meta em conta nova | Cliente completa manual 1x no AdsPower |

---

## Versionamento

A cada update significativo, criar uma tag:
```bash
git tag v1.1.0 -m "fix: ajuste seletor 'Compartilhar'"
git push --tags
```

E no zap pro Gustavo:
> "v1.1.0 - corrigi o botão Compartilhar. Roda `update.bat`."
