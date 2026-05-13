import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adsPowerProfileInputSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { adsPowerClient, AdsPowerError } from '../../automation/adspower-client.js';

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

  // Sync from AdsPower (FIX 17): puxa todos os perfis do AdsPower local API
  // (paginado) e upserta no DB local. Cria perfis novos, atualiza nome dos
  // existentes (notes do user nao sao tocadas). Usado pra evitar copia/cola
  // manual quando user tem dezenas de perfis no AdsPower.
  //
  // Throttle: AdsPower API tem 1 req/s, ja serializado pelo client.
  // Page size 100, safety limit de 50 paginas (5000 perfis max).
  app.post('/adspower-profiles/sync', async (_req, reply) => {
    const pageSize = 100;
    const SAFETY_LIMIT = 50;
    let page = 1;
    let totalFetched = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    try {
      while (page <= SAFETY_LIMIT) {
        const profiles = await adsPowerClient.listProfiles(page, pageSize);
        if (profiles.length === 0) break;
        totalFetched += profiles.length;
        for (const p of profiles) {
          if (!p.user_id || !p.name) {
            skipped++;
            continue;
          }
          const existing = await prisma.adsPowerProfile.findUnique({
            where: { adsPowerId: p.user_id },
          });
          if (existing) {
            if (existing.name !== p.name) {
              await prisma.adsPowerProfile.update({
                where: { adsPowerId: p.user_id },
                data: { name: p.name },
              });
              updated++;
            }
          } else {
            await prisma.adsPowerProfile.create({
              data: { adsPowerId: p.user_id, name: p.name },
            });
            created++;
          }
        }
        if (profiles.length < pageSize) break;
        page++;
      }
      return { ok: true, fetched: totalFetched, created, updated, skipped };
    } catch (err) {
      if (err instanceof AdsPowerError) {
        return reply.status(502).send({ ok: false, error: 'adspower_api', reason: err.message });
      }
      const msg = err instanceof Error ? err.message : 'unknown';
      return reply.status(500).send({ ok: false, error: 'sync_failed', reason: msg });
    }
  });
}
