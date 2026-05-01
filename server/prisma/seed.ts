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

  await prisma.appSetting.upsert({
    where: { key: 'MAX_ACTIVE_ACCOUNTS' },
    update: {},
    create: { key: 'MAX_ACTIVE_ACCOUNTS', value: '1' },
  });
  console.log('✓ settings');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
