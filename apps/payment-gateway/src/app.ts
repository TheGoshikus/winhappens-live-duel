import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerHealth, type Probe } from './health.js';

export interface GatewayDeps {
  probes: Record<string, Probe>;
}

export function buildApp(deps: GatewayDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);
  registerHealth(app, 'payment-gateway', deps.probes);
  return app;
}
