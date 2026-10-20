import type { FastifyInstance } from 'fastify';
import type { HealthCheck, HealthResponse } from '@winhappens/shared';

export type Probe = () => Promise<void>;

const PROBE_TIMEOUT_MS = 1_000;

async function runProbe(probe: Probe): Promise<HealthCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /health — 200, если все зависимости живы, иначе 503 со статусом каждой. */
export function registerHealth(
  app: FastifyInstance,
  service: string,
  probes: Record<string, Probe>,
) {
  app.get('/health', async (_req, reply): Promise<HealthResponse> => {
    const entries = await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => [name, await runProbe(probe)] as const),
    );
    const checks = Object.fromEntries(entries);
    const ok = entries.every(([, c]) => c.status === 'up');
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      service,
      uptimeSec: Math.round(process.uptime()),
      checks,
    };
  });
}
