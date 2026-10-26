import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { registerHealth, type Probe } from './health.js';
import { registerAuth } from './identity/auth.js';
import { identityRoutes, type IdentityRoutesDeps } from './identity/routes.js';
import { paymentRoutes, type PaymentRoutesDeps } from './payments/routes.js';
import { realtimeGateway, type RealtimeDeps } from './realtime/gateway.js';
import { roundRoutes, type RoundRoutesDeps } from './rounds/routes.js';
import { videoRoutes, type VideoRoutesDeps } from './video/routes.js';
import { walletRoutes, type WalletRoutesDeps } from './wallet/routes.js';

export interface CoreDeps {
  probes: Record<string, Probe>;
  /** Без identity поднимается только /health (тесты каркаса). */
  identity?: IdentityRoutesDeps;
  wallet?: WalletRoutesDeps;
  video?: VideoRoutesDeps;
  rounds?: RoundRoutesDeps;
  payments?: PaymentRoutesDeps;
  realtime?: RealtimeDeps;
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
  const { identity, wallet, video, rounds, payments, realtime } = deps;
  if (identity) {
    registerAuth(app, identity.tokens);
    app.register(async (scope) => identityRoutes(scope, identity));
    if (wallet) app.register(async (scope) => walletRoutes(scope, wallet));
    if (video) app.register(async (scope) => videoRoutes(scope, video));
    if (rounds) app.register(async (scope) => roundRoutes(scope, rounds));
    if (payments) app.register(async (scope) => paymentRoutes(scope, payments));
    if (realtime) app.register(async (scope) => realtimeGateway(scope, realtime));
  }
  return app;
}
