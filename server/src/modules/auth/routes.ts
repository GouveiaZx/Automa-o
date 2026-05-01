import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { loginSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user) return reply.status(401).send({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.status(401).send({ error: 'invalid_credentials' });
    const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '7d' });
    return { token, user: { id: user.id, email: user.email } };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const u = req.user as { sub: string; email: string };
    return { id: u.sub, email: u.email };
  });
}
