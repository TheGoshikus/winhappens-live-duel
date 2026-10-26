import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unauthorized } from '../errors.js';
import type { Tokens } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Пользователь из Bearer-токена; null — анонимный запрос. */
    userId: string | null;
  }
}

/** Регистрируется на корневом экземпляре, чтобы userId был виден во всех модулях. */
export function registerAuth(app: FastifyInstance, tokens: Tokens) {
  app.decorateRequest('userId', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) req.userId = (await tokens.verifyAccess(h.slice(7))).userId;
  });
}

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw unauthorized();
  return req.userId;
}
