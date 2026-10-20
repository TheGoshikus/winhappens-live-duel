import { healthResponseSchema } from '@winhappens/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('GET /health', () => {
  it('200 и ok, когда зависимости живы', async () => {
    const app = buildApp({ probes: { postgres: async () => {} } });
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.checks.postgres?.status).toBe('up');
  });

  it('503 и degraded, когда зависимость упала', async () => {
    const app = buildApp({
      probes: {
        postgres: async () => {},
        broken: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(503);
    const body = healthResponseSchema.parse(res.json());
    expect(body.status).toBe('degraded');
    expect(body.checks.broken).toEqual({ status: 'down', error: 'ECONNREFUSED' });
  });
});
