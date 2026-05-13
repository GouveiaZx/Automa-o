import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

  // Bulk delete (FIX 14): exclui N perfis AdsPower de uma vez. Schema tem
  // InstagramAccount.adsPowerProfileId com onDelete: SetNull — entao contas
  // IG vinculadas NAO sao deletadas, so ficam orfas (adsPowerProfileId=null).
  // UI deve avisar o user disso.
  app.post('/adspower-profiles/bulk-delete', async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const result = await prisma.adsPowerProfile.deleteMany({
      where: { id: { in: parsed.data.ids } },
    });
    return { ok: true, deleted: result.count };
  });
}
