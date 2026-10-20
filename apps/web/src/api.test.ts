import { describe, expect, it } from 'vitest';
import { fetchHealth } from './api.js';

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchHealth', () => {
  it('разбирает и деградированный ответ', async () => {
    const body = {
      status: 'degraded',
      service: 'core',
      uptimeSec: 1,
      checks: { redis: { status: 'down', error: 'x' } },
    };
    await expect(fetchHealth(respond(503, body))).resolves.toEqual(body);
  });

  it('падает на неожиданном теле', async () => {
    await expect(fetchHealth(respond(200, { hello: 1 }))).rejects.toThrow();
  });
});
