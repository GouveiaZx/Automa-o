import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@local';
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'admin123';
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });
  console.log(`✓ admin: ${admin.email} (senha do .env)`);

  const campaign = await prisma.campaign.upsert({
    where: { id: 'seed-campaign' },
    update: {},
    create: {
      id: 'seed-campaign',
      name: 'Campanha de Exemplo',
      description: 'Campanha criada pelo seed para testes',
      windowStart: '08:00',
      windowEnd: '22:00',
      minIntervalMin: 90,
      maxIntervalMin: 240,
      storiesPerDay: 3,
      reelsPerDay: 1,
      active: true,
    },
  });
  console.log(`✓ campanha: ${campaign.name}`);

  // MAX_ACTIVE_ACCOUNTS NAO eh criado por padrao. Sem essa key = sem cap = todas as
  // contas active sao processadas. Antes o seed criava com valor "1" pra rollout
  // progressivo da Etapa 4 da spec, mas isso fazia jobs de 2+ contas ficarem queued
  // pra sempre sem aviso. Hoje quem quiser limitar pode criar via UI Configuracoes.
  console.log('✓ settings (MAX_ACTIVE_ACCOUNTS sem cap por padrao - configure em /dashboard/settings se quiser limitar)');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
