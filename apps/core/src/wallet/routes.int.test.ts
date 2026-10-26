import { loadCoreConfig } from '@winhappens/config';
import { walletHistoryResponseSchema, walletResponseSchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import { createIdentityModule, createWalletModule } from '../wiring.js';

let app: FastifyInstance;
let stop: () => Promise<void>;

beforeAll(async () => {
  const t = await startTestDb();
  stop = t.stop;
  const config = loadCoreConfig(testEnv);
  app = buildApp({
    probes: {},
    identity: createIdentityModule(t.db, config),
    wallet: createWalletModule(t.db, config),
  });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});

const guest = async () =>
  (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json()
    .accessToken as string;
const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe('/wallet', () => {
  it('гость получает стартовые фантики один раз', async () => {
    const token = await guest();
    for (let i = 0; i < 2; i++) {
      const w = walletResponseSchema.parse((await get('/wallet', token)).json());
      expect(w.FUN).toEqual({ main: 100_000n, hold: 0n, pendingWithdrawal: 0n });
      expect(w.USDT.main).toBe(0n);
    }
  });

  it('требует авторизацию', async () => {
    expect((await app.inject({ method: 'GET', url: '/wallet' })).statusCode).toBe(401);
  });

  it('dev-пополнение USDT и история с курсором', async () => {
    const token = await guest();
    for (const amount of ['1000000', '2500000', '500000']) {
      const r = await app.inject({
        method: 'POST',
        url: '/dev/wallet/deposit',
        headers: { authorization: `Bearer ${token}` },
        payload: { amount },
      });
      expect(r.statusCode).toBe(204);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/dev/wallet/deposit',
          headers: { authorization: `Bearer ${token}` },
          payload: { amount: '-5' },
        })
      ).statusCode,
    ).toBe(400);
    expect(walletResponseSchema.parse((await get('/wallet', token)).json()).USDT.main).toBe(
      4_000_000n,
    );

    const page1 = walletHistoryResponseSchema.parse(
      (await get('/wallet/history?currency=USDT&limit=2', token)).json(),
    );
    expect(page1.items.map((i) => i.amount)).toEqual([500_000n, 2_500_000n]);
    expect(page1.items[0]).toMatchObject({ kind: 'deposit', balanceAfter: 4_000_000n });
    const page2 = walletHistoryResponseSchema.parse(
      (await get(`/wallet/history?currency=USDT&limit=2&before=${page1.nextBefore}`, token)).json(),
    );
    expect(page2.items.map((i) => i.amount)).toEqual([1_000_000n]);
    expect(page2.nextBefore).toBeNull();
  });
});
