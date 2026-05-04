import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { loginSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { appLog } from '../../logger.js';

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/auth/login',
    {
      // Brute force protection: 10 tentativas / 5 min por IP, sem allowList
      // (vale ate de localhost caso porta 3010 esteja exposta na rede).
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',
          allowList: () => false,
        },
      },
    },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      const { email, password } = parsed.data;
      const user = await prisma.adminUser.findUnique({ where: { email } });
      if (!user) {
        await appLog({
          source: 'api',
          level: 'warn',
          message: `Login falhou (email desconhecido): ${email} de ${req.ip}`,
        });
        return reply.status(401).send({ error: 'invalid_credentials' });
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        await appLog({
          source: 'api',
          level: 'warn',
          message: `Login falhou (senha errada): ${email} de ${req.ip}`,
        });
        return reply.status(401).send({ error: 'invalid_credentials' });
      }
      const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '7d' });
      return { token, user: { id: user.id, email: user.email } };
    }
  );

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const u = req.user as { sub: string; email: string };
    return { id: u.sub, email: u.email };
  });
}
