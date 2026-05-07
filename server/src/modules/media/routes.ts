import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { mediaInputSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';

const MEDIA_DIR = join(process.cwd(), 'media');
// .webp e .heic comuns hoje em fotos de celular (iPhone HEIC, screenshots .webp).
// .webm e .m4v video files comuns. IG aceita todos via upload nativo.
const ALLOWED = new Set([
  '.mp4', '.mov', '.webm', '.m4v',
  '.jpg', '.jpeg', '.png', '.webp', '.heic',
]);
const MAX_SIZE_MB = 200;

export async function mediaRoutes(app: FastifyInstance) {
  await mkdir(MEDIA_DIR, { recursive: true });
  app.addHook('preHandler', app.authenticate);

  app.get('/media', async (req) => {
    const q = req.query as { campaignId?: string; type?: string };
    return prisma.mediaItem.findMany({
      where: {
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        ...(q.type ? { type: q.type } : {}),
      },
      include: { campaign: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/media/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.mediaItem.findUnique({ where: { id }, include: { campaign: true } });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    return item;
  });

  app.post('/media', async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.status(400).send({ error: 'multipart_required' });
    }
    const parts = req.parts();
    let file: { buffer: Buffer; filename: string } | null = null;
    const fields: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of part.file) {
          size += chunk.length;
          if (size > MAX_SIZE_MB * 1024 * 1024) {
            return reply.status(413).send({ error: 'file_too_large' });
          }
          chunks.push(chunk);
        }
        file = { buffer: Buffer.concat(chunks), filename: part.filename };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!file) return reply.status(400).send({ error: 'file_required' });
    const ext = extname(file.filename).toLowerCase();
    if (!ALLOWED.has(ext)) {
      return reply.status(400).send({ error: 'unsupported_extension', allowed: [...ALLOWED] });
    }

    const parsed = mediaInputSchema.safeParse({
      type: fields.type,
      caption: fields.caption ?? null,
      linkUrl: fields.linkUrl || null,
      tag: fields.tag || null,
      campaignId: fields.campaignId,
    });
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: parsed.data.campaignId } });
    if (!campaign) return reply.status(400).send({ error: 'campaign_not_found' });

    const safeName = `${randomUUID()}${ext}`;
    const fullPath = join(MEDIA_DIR, safeName);
    await writeFile(fullPath, file.buffer);

    return prisma.mediaItem.create({
      data: {
        type: parsed.data.type,
        filePath: safeName,
        caption: parsed.data.caption ?? null,
        linkUrl: parsed.data.linkUrl ?? null,
        tag: parsed.data.tag ?? null,
        campaignId: parsed.data.campaignId,
      },
      include: { campaign: true },
    });
  });

  app.delete('/media/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    try {
      await unlink(join(MEDIA_DIR, item.filePath));
    } catch {
      /* arquivo já não existe */
    }
    await prisma.mediaItem.delete({ where: { id } });
    return { ok: true };
  });
}
