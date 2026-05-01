import type { FastifyInstance } from 'fastify';
import { adsPowerProfileInputSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';

export async function adsPowerProfileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/adspower-profiles', async () =>
    prisma.adsPowerProfile.findMany({
      include: { account: true },
      orderBy: { name: 'asc' },
    })
  );

  app.get('/adspower-profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.adsPowerProfile.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    return item;
  });

  app.post('/adspower-profiles', async (req, reply) => {
    const parsed = adsPowerProfileInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    try {
      return await prisma.adsPowerProfile.create({
        data: { ...parsed.data, notes: parsed.data.notes ?? null },
      });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'P2002') {
        return reply.status(409).send({ error: 'duplicate_adspower_id' });
      }
      throw err;
    }
  });

  app.put('/adspower-profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = adsPowerProfileInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    try {
      return await prisma.adsPowerProfile.update({ where: { id }, data: parsed.data });
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });

  app.delete('/adspower-profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await prisma.adsPowerProfile.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });
}
