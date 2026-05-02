# 📩 Mensagem pro Gustavo (cole no zap)

---

Fala Gustavo, beleza? 👋

Refiz o instalador pra ficar **bem mais simples**. Vou te mandar 1 arquivo só. Você só clica 2 vezes nele e o sistema baixa, instala, configura E já abre sozinho.

---

## 📦 O que você vai receber

**1 único arquivo: `INSTALAR.bat`**

(eu já configurei a chave de acesso dentro dele — você não precisa colar URL nenhuma)

---

## ⚠️ Antes de instalar — 3 coisas pra você saber

### 1. AdsPower **plano pago** é obrigatório
A versão grátis trava após poucas aberturas/dia. Se você tem **10+ contas postando várias vezes/dia, sem o plano pago não roda**.

### 2. Story 24h "real" do Instagram não rola pelo Web
Limitação do próprio Instagram (não do código). Em conta nova, o Web não tem o criador de Story — só o app no celular. Pra contornar, **o sistema posta como POST permanente no feed**.

### 3. Link clicável só funciona NA BIO do perfil, não na caption
Instagram não permite link clicável no texto do post. **Mas tem botão clicável na bio** — então o sistema atualiza o "Site" do perfil IG via painel (botão 🔄 ao lado de cada conta).

---

## 🚀 Como instalar (5 cliques no total)

### Passo 1 — Salva o `INSTALAR.bat`
Salva o arquivo que te mandei na **Área de Trabalho** ou **Downloads**.

### Passo 2 — Clica 2x no `INSTALAR.bat`

Vai aparecer uma janela preta. **Não fecha**.

Se você **não tiver Node.js ou Git instalados**, ele vai te avisar e abrir a página pra baixar:

- **Node.js**: https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
- **Git**: https://git-scm.com/download/win

Instala ambos (next, next, next), depois **clica 2x no INSTALAR.bat de novo**.

### Passo 3 — Aguarda ~10 minutos
A janela vai mostrar:
```
[1/5] Verificando Node.js...
[2/5] Verificando Git...
[3/5] Baixando o sistema...
[4/5] Instalando componentes...
[5/5] Configurando...
```

Quando ver `INSTALACAO CONCLUIDA!` tá pronto.

### Passo 4 — Quando perguntar "Quer iniciar agora? (S/N)"
Digite **S** e tecla ENTER.

### Passo 5 — O sistema abre sozinho
Vão aparecer 3 janelas pretas (server, worker, painel). **NÃO FECHA NENHUMA** durante a operação.

Em ~15 segundos, o seu navegador vai abrir em http://localhost:3000.

**Login:**
- Email: `admin@local`
- Senha: `admin123`

**Pode trocar a senha depois pelo painel.** ⚠️ Se for usar com dados sensíveis, troque já.

---

## 🎬 Como usar todo dia (depois de instalado)

### 1. Abre o AdsPower
Garanta que ele esteja rodando, com pelo menos 1 perfil tendo Instagram **logado manualmente** (com bio configurada, etc).

### 2. Clica no atalho na Área de Trabalho
**"Instagram Automation"** — eu criei pra você na hora da instalação.

3 janelas pretas vão abrir. **NÃO FECHA NENHUMA**. Aguarda 15 segundos. O navegador abre sozinho.

### 3. No painel:
- **Diagnóstico** → "Recarregar" (deve mostrar verde)
- **Perfis AdsPower** → cadastra com o `user_id` real (coluna ID do AdsPower)
- **Contas Instagram** → cadastra a conta IG, **bio**, **Site (link clicável)**, vincula o perfil
- **Diagnóstico** → "Testar" no perfil → confirma `logado ✓`

### 4. Pra postar
- **Mídia** → upload do conteúdo (jpg/mp4)
- **Fila de jobs** → "Agendar postagem" → escolhe conta + mídia
- Acompanha em **Logs**

### 5. Pra atualizar bio + site no IG
**Contas Instagram** → botão 🔄 ao lado da conta. Sistema abre AdsPower e atualiza sozinho.

---

## 🆘 Se der ERRO durante a instalação

**Roda o `DIAGNOSTICAR.bat`** (eu te mando junto). Ele vai gerar um arquivo `automacao-diagnostico.txt` na sua pasta de usuário.

**Manda esse arquivo pra mim no zap** + descrição do que apareceu na janela. Em 90% dos casos eu identifico o problema e te mando uma versão corrigida.

---

## 🔄 Quando eu te avisar de uma versão nova

1. Fecha as 3 janelas do sistema
2. Vai na pasta `C:\Users\<seu-usuario>\automacao\`
3. Clica 2x em **`update.bat`**
4. Aguarda terminar
5. Abre o atalho "Instagram Automation" da Área de Trabalho de novo

---

## 💬 Resumo

- Versão `v1.0.0` — ponto de partida
- Tudo da spec original implementado
- **1 post real validado** aqui (foto subiu de fato no IG)
- Pode dar bug pequeno na primeira semana (ajuste de layout do IG conforme você usa) — eu resolvo rápido

Bora! 🚀
