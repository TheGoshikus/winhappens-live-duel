import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { registerHealth, type Probe } from './health.js';
import { identityRoutes, type IdentityRoutesDeps } from './identity/routes.js';

export interface CoreDeps {
  probes: Record<string, Probe>;
  /** Без identity поднимается только /health (тесты каркаса). */
  identity?: IdentityRoutesDeps;
}

export function buildApp(deps: CoreDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  registerHealth(app, 'core', deps.probes);
  const identity = deps.identity;
  if (identity) app.register(async (scope) => identityRoutes(scope, identity));
  return app;
}
