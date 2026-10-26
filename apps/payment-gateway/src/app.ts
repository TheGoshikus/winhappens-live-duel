import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerHealth, type Probe } from './health.js';
import { gatewayRoutes, type GatewayRoutesDeps } from './routes.js';

export interface GatewayDeps {
  probes: Record<string, Probe>;
  /** Без маршрутов поднимается только /health (тесты каркаса). */
  routes?: GatewayRoutesDeps;
}

export function buildApp(deps: GatewayDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);
  registerHealth(app, 'payment-gateway', deps.probes);
  const routes = deps.routes;
  if (routes) app.register(async (scope) => gatewayRoutes(scope, routes));
  return app;
}
