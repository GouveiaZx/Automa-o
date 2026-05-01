import type { FastifyInstance } from 'fastify';
import { campaignInputSchema, campaignPartialSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/campaigns', async () => {
    return prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } });
  });

  app.get('/campaigns/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.campaign.findUnique({
      where: { id },
      include: { accounts: true, media: true },
    });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    return item;
  });

  app.post('/campaigns', async (req, reply) => {
    const parsed = campaignInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    return prisma.campaign.create({ data: { ...parsed.data, description: parsed.data.description ?? null } });
  });

  app.put('/campaigns/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = campaignPartialSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    try {
      return await prisma.campaign.update({ where: { id }, data: parsed.data });
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });

  app.delete('/campaigns/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await prisma.campaign.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });
}
