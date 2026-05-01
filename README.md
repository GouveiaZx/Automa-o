# Instagram Automation (AdsPower)

Painel administrativo + worker para automatizar postagens de Stories e Reels no Instagram através de perfis AdsPower já logados.

> **Para o cliente final:** abra o **[SETUP_CLIENTE.md](SETUP_CLIENTE.md)** e siga o roteiro Windows. Para entregar a nova versão, use os scripts `install.bat` e `start.bat`.

## Stack

- **Backend**: Fastify + TypeScript + Prisma (SQLite)
- **Frontend**: Next.js 15 (App Router) + Tailwind + shadcn/ui
- **Worker**: processo Node.js separado, fila baseada em SQLite
- **Modo de automação**: mock (default, sem AdsPower) ou real (Playwright + AdsPower API)

## Estrutura

```
.
├── server/    # API Fastify + worker + Prisma
├── client/    # Painel Next.js
├── shared/    # Tipos e schemas zod compartilhados
└── package.json   # Workspaces
```

## Pré-requisitos

- Node.js >= 20 (testado em v22)
- npm >= 10
- (Etapa 3) AdsPower instalado e rodando em `http://localhost:50325`

## Setup

```bash
# 1. Instalar dependências (todos os workspaces)
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
cp .env.example server/.env

# 3. Criar banco e aplicar migrations
npm run db:migrate

# 4. Seed: cria admin e dados de exemplo
npm run db:seed

# 5. Subir tudo (server :3001, worker, client :3000)
npm run dev
```

Acesse http://localhost:3000 e faça login com as credenciais do `.env` (default `admin@local` / `admin123`).

## Modos de automação

Definido em `AUTOMATION_MODE`:

- `mock` — simula AdsPower e Instagram. Usa delays aleatórios e falhas controladas para validar fila, retry, pause e alertas. **Não abre browser nem Instagram real.**
- `real` — Etapa 3 (em desenvolvimento). Usa Playwright + AdsPower API local.

## Scripts úteis

```bash
npm run dev           # API + worker + client em paralelo
npm run dev:server    # apenas API
npm run dev:worker    # apenas worker
npm run dev:client    # apenas frontend
npm run build         # compila tudo
npm run lint          # lint em todos workspaces
npm run typecheck     # verifica tipos
npm run db:migrate    # aplica migrations Prisma
npm run db:studio     # abre Prisma Studio (visualizador do DB)
npm run db:seed       # popula DB com admin + exemplos
```

## Fluxo (modo mock)

1. Cadastrar uma **Campanha** (janela, cadência, story/reel por dia)
2. Cadastrar um **Perfil AdsPower** (id mock qualquer)
3. Cadastrar uma **Conta Instagram** vinculada ao perfil + campanha
4. **Upload** de mídia (mp4 pequeno qualquer)
5. Clicar em **Agendar postagem** → job entra na fila
6. Worker processa em ~5s → status muda para `running` → `done` ou `failed→retry→done`
7. Logs aparecem em tempo real; alerta visual + sonoro se conta entra em `paused`

## Roadmap

- [x] Etapa 1 — Base local (CRUD, banco, auth, upload)
- [x] Etapa 2 — Modo mock + worker + fila + retry + alertas
- [ ] Etapa 3 — Real driver (Playwright + AdsPower API)
- [ ] Etapa 4 — Validação progressiva (1 → 3 → 7 → 10 → 30 contas)
