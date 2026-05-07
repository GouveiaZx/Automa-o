import type { FastifyInstance } from 'fastify';
import { bus } from '../../events.js';

export async function sseRoutes(app: FastifyInstance) {
  app.get('/events', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (token) {
      try {
        await app.jwt.verify(token);
      } catch {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    } else {
      try {
        await req.jwtVerify();
      } catch {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`: connected\n\n`);

    let cleaned = false;
    let off: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      if (off) off();
    };

    off = bus.onEvent((event) => {
      // Se write falhar (conexao caiu mid-write), limpa listener pra nao acumular.
      // Sem isso, listeners ficavam grudados ate atingir setMaxListeners(50) e logar warning.
      try {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
      } catch {
        cleanup();
      }
    });

    heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        cleanup();
      }
    }, 25000);

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    return reply;
  });
}
