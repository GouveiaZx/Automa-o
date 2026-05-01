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

    const off = bus.onEvent((event) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
    });

    return reply;
  });
}
