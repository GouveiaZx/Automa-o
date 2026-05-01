Estratégia de Desenvolvimento e Implantação

O desenvolvimento deve ser feito primeiro em ambiente local do desenvolvedor, sem depender inicialmente da máquina do cliente.

A máquina do cliente será usada apenas em uma segunda fase, para validação real da integração com AdsPower, Instagram e perfis reais.

## Fase 1 - Desenvolvimento Local

Nesta fase, implementar e testar localmente:

- Painel web
- Backend/API
- Banco de dados
- Autenticação admin
- CRUD de campanhas/modelos
- CRUD de perfis AdsPower
- CRUD de contas Instagram
- Vinculação perfil + conta + campanha
- Upload de vídeos e Stories
- Fila de postagens
- Logs
- Status
- Alertas visuais
- Alerta sonoro
- Worker base

Nesta fase, não depender da API real do AdsPower.

Criar um modo mock/fake para simular:

- abertura de perfil AdsPower
- conta logada
- postagem de Story
- postagem de Reel
- erro de postagem
- pausa de conta
- atualização de status
- publicação concluída
- vídeo saindo da fila

## Fase 2 - Modo Mock para Testes

Criar uma variável de ambiente:

```env
AUTOMATION_MODE=mock

Valores possíveis:

AUTOMATION_MODE=mock
AUTOMATION_MODE=real

Quando AUTOMATION_MODE=mock, o sistema não deve abrir AdsPower nem Instagram real.

Ele deve apenas simular o comportamento para validar:

criação de jobs
execução da fila
status da conta
logs
retry uma vez em caso de erro
pausa após falha
marcação de mídia como publicada
cálculo do próximo horário
alertas no painel

Quando AUTOMATION_MODE=real, o sistema deve usar AdsPower + Playwright/Puppeteer.

Fase 3 - Instalação na Máquina do Cliente

Depois que a base estiver pronta localmente, instalar/configurar na máquina do cliente.

A máquina informada pelo cliente:

Ryzen 9 7900X
32 GB DDR
Radeon RX6600 8 GB
SSD 1 TB

Atividades na máquina do cliente:

Instalar Node.js, se necessário
Instalar dependências do projeto
Configurar .env
Configurar AUTOMATION_MODE=real
Validar URL/API do AdsPower
Obter API Key/token do AdsPower, se necessário
Testar abertura de 1 perfil AdsPower
Validar se Instagram está logado no perfil
Testar publicação de 1 Reel
Testar publicação de 2 Stories
Validar logs/status no painel
Ajustar seletores e fluxos de automação conforme interface real do Instagram
Fase 4 - Validação Progressiva

Não iniciar com 20 contas diretamente.

Sequência obrigatória de validação:

1 conta real
3 contas reais
7 contas reais
10 contas reais
15 a 20 contas, se a máquina e o AdsPower suportarem
Login Instagram e 2FA

Para MVP, o sistema deve priorizar o uso de perfis AdsPower já logados manualmente pelo operador.

Motivo:

reduz problemas com 2FA
evita travamento por checkpoint
deixa a operação mais controlada
diminui chance de falha no fluxo de login

O sistema deve detectar se o perfil está logado.

Se não estiver logado:

pausar a conta
registrar log
exibir alerta no painel
solicitar login manual no AdsPower

Não automatizar 2FA na primeira versão, salvo se for extremamente necessário depois.


---

# Prompt atualizado para iniciar localmente

Esse é o prompt que eu usaria agora no seu PC:

```text
Leia o arquivo INSTAGRAM_AUTOMATION_PROJECT.md inteiro.

Vamos desenvolver primeiro localmente, sem depender da máquina do cliente.

O sistema deve ter dois modos:

1. AUTOMATION_MODE=mock
- simula AdsPower
- simula Instagram
- simula postagem de Story/Reel
- simula erros
- valida filas, logs, status, retry e alertas

2. AUTOMATION_MODE=real
- futuramente usa AdsPower real + Playwright/Puppeteer

Agora implemente somente a ETAPA 1 e ETAPA 2 da base local:

- Estrutura do projeto full stack
- Backend Node.js + TypeScript
- Frontend React/Next.js + TypeScript
- Banco SQLite com Prisma
- Autenticação admin simples
- Seed de usuário admin
- Entidades:
  - Campaign
  - AdsPowerProfile
  - InstagramAccount
  - MediaItem
  - PostJob
  - AutomationLog
  - AppSetting
- CRUD de campanhas/modelos
- CRUD de perfis AdsPower
- CRUD de contas Instagram
- Vinculação entre conta, perfil AdsPower e campanha
- .env.example com AUTOMATION_MODE=mock
- README inicial com comandos de instalação

Não implemente ainda a automação real do Instagram.
Não implemente ainda Playwright/Puppeteer real.
Não conecte ainda AdsPower real.

Primeiro quero a base compilando sem erros e funcionando localmente com banco, APIs e telas principais.
Ao final, rode build/lint quando possível e me informe:
- arquivos criados
- comandos para rodar
- o que foi implementado
- o que falta para a próxima etapa