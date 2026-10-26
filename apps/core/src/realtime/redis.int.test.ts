import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { ServerEventWire } from '@winhappens/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROADCAST, createRedisBus } from './bus.js';
import { createRedisPresence, PRESENCE_TTL_MS } from './presence.js';

let container: StartedRedisContainer;
const clients: Redis[] = [];
const redis = () => {
  const r = new Redis(container.getConnectionUrl());
  clients.push(r);
  return r;
};

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit()));
  await container?.stop();
});

describe('Redis', () => {
  it('шина: событие, опубликованное одним инстансом, доходит до подписчика другого', async () => {
    const a = createRedisBus(redis(), redis());
    const b = createRedisBus(redis(), redis());
    const got: [string, ServerEventWire][] = [];
    const off = await b.subscribe((u, e) => got.push([u, e]));
    await a.publish('u1', { type: 'dealers.updated' });
    await a.broadcast({ type: 'pong' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([
      ['u1', { type: 'dealers.updated' }],
      [BROADCAST, { type: 'pong' }],
    ]);
    await off();
  });

  it('присутствие: аренда соединения, выход и истечение без продления', async () => {
    let now = 1_800_000_000_000;
    const p = createRedisPresence(redis(), () => now);
    await p.touch('u2', 'c1');
    await p.touch('u2', 'c2');
    expect(await p.isOnline('u2')).toBe(true);
    await p.drop('u2', 'c1');
    expect(await p.isOnline('u2')).toBe(true);
    now += PRESENCE_TTL_MS + 1; // c2 не продлевался — инстанс «упал»
    expect(await p.isOnline('u2')).toBe(false);
  });
});
