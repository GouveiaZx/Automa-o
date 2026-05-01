# 📩 Mensagem pro Gustavo (cole no zap)

---

Fala Gustavo, beleza? 👋

Te mandei aqui o sistema pronto pra rodar aí no seu PC. Vou deixar o mais simples possível. Você só precisa **clicar 2 vezes em um arquivo** e o sistema baixa, instala e configura sozinho.

---

## 📦 Você vai receber 2 coisas no zap

1. Um arquivo chamado **`INSTALAR.bat`** (anexo)
2. Uma **URL secreta** que começa com `https://x-access-token:...` (mensagem de texto)

A URL é o "endereço" do sistema dentro do GitHub. Guarda ela pra colar no instalador.

---

## ⚠️ Antes de instalar — 3 coisas pra você saber

### 1. AdsPower **plano pago** é obrigatório
A versão grátis trava após poucas aberturas/dia. Se você tem **10+ contas postando várias vezes/dia, sem o plano pago não roda**. Já tem o plano? Tudo certo.

### 2. Story 24h "real" do Instagram não rola pelo Web
Limitação do próprio Instagram (não do código). Em conta nova, o Web não tem o criador de Story — só o app no celular. Pra contornar, **o sistema posta como POST permanente no feed**. Se quiser Story 24h de verdade, é pelo celular manual ou a gente desenvolve uma integração mobile depois.

### 3. Link clicável só funciona NA BIO do perfil, não na caption
Instagram não permite link clicável no texto do post. **Mas tem botão clicável na bio** — então o sistema atualiza o "Site" do perfil IG via painel (botão 🔄 ao lado de cada conta).

---

## 🚀 Como instalar (super simples)

### Passo 1 — Instalar Node.js
Baixa e instala (next, next, next):
**https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi**

### Passo 2 — Instalar Git
Baixa e instala (next, next, next, deixa tudo padrão):
**https://git-scm.com/download/win**

### Passo 3 — Abrir o `INSTALAR.bat`
Salva o arquivo `INSTALAR.bat` que te mandei na sua **Área de Trabalho** ou **Downloads**.

Clica 2 vezes nele.

Vai aparecer uma janela preta (PowerShell). Não fecha. Apenas siga as instruções.

### Passo 4 — Quando pedir, cole a URL secreta
A janela vai pedir:
```
URL:
```
**Cola aqui** a URL que te mandei (clica direito no PowerShell e seleciona "colar").

### Passo 5 — Quando pedir, define uma senha
Depois ele vai pedir:
```
Senha de admin:
```
**Digita uma senha** que você vai lembrar (ex: `meunomeesseguro123`). Aperta ENTER.

### Passo 6 — Espera ~10 minutos
Ele vai baixar e instalar tudo sozinho. Quando terminar, vai aparecer:
```
INSTALACAO CONCLUIDA!
```

E uma janela do Windows Explorer vai abrir mostrando a pasta `C:\Users\<seu-usuario>\automacao\`.

---

## 🎬 Como usar todo dia

### 1. Abre o AdsPower
Garanta que ele esteja rodando, com pelo menos 1 perfil tendo Instagram **logado manualmente** (com bio configurada, etc).

### 2. Vai na pasta `automacao`
Clica 2 vezes em **`start.bat`**.

3 janelinhas pretas vão abrir. **NÃO FECHA NENHUMA**. Aguarda 15 segundos.

### 3. Abre o navegador em
**http://localhost:3000**

Login: `admin@local`
Senha: a que você escolheu na instalação

### 4. Cadastrar uma vez:
- **Diagnóstico** → Recarregar (deve mostrar verde)
- **Perfis AdsPower** → cadastra com o `user_id` real (coluna ID do AdsPower)
- **Contas Instagram** → cadastra a conta IG, **bio**, **Site (link clicável)**, vincula o perfil
- **Diagnóstico** → "Testar" no perfil → confirma `logado ✓`

### 5. Pra postar
- **Mídia** → upload do conteúdo (jpg/mp4)
- **Fila de jobs** → "Agendar postagem" → escolhe conta + mídia
- Acompanha em **Logs**

### 6. Pra atualizar bio + site no IG
**Contas Instagram** → botão 🔄 ao lado da conta. Sistema abre AdsPower e atualiza sozinho.

---

## 🆘 Se der algum erro

**Antes de me chamar:**
1. Olha **Logs** no painel — última linha vai dizer o erro
2. Olha em `C:\Users\<seu-usuario>\automacao\server\media\debug\` — pode ter PNG mostrando o que travou

**Me manda no zap:**
- Print do erro
- O PNG mais recente da `media\debug\`
- Que ação você tava tentando

**99% das coisas eu resolvo daqui** sem precisar acessar seu PC. Mando atualização e você roda `update.bat`.

---

## 🔄 Quando eu te avisar de uma versão nova

1. Fecha as 3 janelinhas do sistema (se estiverem abertas)
2. Vai na pasta `C:\Users\<seu-usuario>\automacao\`
3. Clica 2 vezes em **`update.bat`**
4. Aguarda terminar
5. Roda `start.bat` de novo

---

## 💬 Resumo

- Versão `v1.0.0` é o ponto de partida
- Tem tudo da spec original implementado
- **1 post real publicado e validado** aqui
- Pode dar bug pequeno na primeira semana (ajuste de layout do IG conforme você usa) — eu resolvo rápido

Bora! 🚀
