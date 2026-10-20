import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerHealth, type Probe } from './health.js';

export interface CoreDeps {
  probes: Record<string, Probe>;
}

export function buildApp(deps: CoreDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);
  registerHealth(app, 'core', deps.probes);
  return app;
}
