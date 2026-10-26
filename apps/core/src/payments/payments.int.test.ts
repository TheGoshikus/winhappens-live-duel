import { loadCoreConfig } from '@winhappens/config';
import { walletResponseSchema, type PaymentEventWire } from '@winhappens/shared';
import { signBody, verifyBody } from '@winhappens/shared/server';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MockOtpSender } from '../identity/otp.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import { createIdentityModule, createPaymentsModule, createWalletModule } from '../wiring.js';

const config = loadCoreConfig(testEnv);
const SECRET = config.env.PAYMENT_GATEWAY_SECRET;
let app: FastifyInstance;
let stop: () => Promise<void>;
const otp = new MockOtpSender();

/** Фейковый шлюз: запоминает подписанные запросы и отвечает по сценарию. */
const gw = {
  calls: [] as {
    path: string;
    body: Record<string, unknown>;
    key: string | null;
    signed: boolean;
  }[],
  mode: 'ok' as 'ok' | 'reject' | 'down',
};
const fakeFetch = (async (url: string, init: RequestInit) => {
  if (gw.mode === 'down') throw new Error('ECONNREFUSED');
  const path = new URL(url).pathname;
  const body = JSON.parse(String(init.body));
  const h = new Headers(init.headers);
  gw.calls.push({
    path,
    body,
    key: h.get('idempotency-key'),
    signed: verifyBody(SECRET, String(init.body), h.get('x-wh-signature') ?? undefined),
  });
  if (gw.mode === 'reject')
    return Response.json({ error: 'no_provider_for_route' }, { status: 422 });
  if (path === '/v1/deposits') {
    return Response.json(
      {
        intentId: randomUUID(),
        status: 'pending',
        ledgerAmount: body.amount,
        checkoutUrl: 'http://gw.test/mock/checkout/x',
        address: null,
      },
      { status: 201 },
    );
  }
  return Response.json({ payoutId: body.payoutId, status: 'sent' }, { status: 201 });
}) as typeof fetch;

beforeAll(async () => {
  const t = await startTestDb();
  stop = t.stop;
  const identity = createIdentityModule(t.db, config, { otp });
  const wallet = createWalletModule(t.db, config);
  app = buildApp({
    probes: {},
    identity,
    wallet,
    payments: createPaymentsModule(config, identity, wallet, fakeFetch),
  });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});

type U = { userId: string; accessToken: string };
const DE = { 'cf-ipcountry': 'DE' };
const call = async (u: U, url: string, payload?: object, headers: Record<string, string> = {}) => {
  const r = await app.inject({
    method: payload ? 'POST' : 'GET',
    url,
    headers: { ...DE, authorization: `Bearer ${u.accessToken}`, ...headers },
    ...(payload ? { payload } : {}),
  });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const usdt = async (u: U) => walletResponseSchema.parse((await call(u, '/wallet')).body).USDT;
let seq = 0;
async function registered(kyc: boolean): Promise<U> {
  const destination = `pay${++seq}@example.com`;
  const { challengeId } = (
    await app.inject({
      method: 'POST',
      url: '/auth/otp/start',
      payload: { channel: 'email', destination },
    })
  ).json();
  const u = (
    await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      headers: DE,
      payload: { challengeId, code: otp.lastCodeFor(destination) },
    })
  ).json() as U;
  if (kyc) {
    await call(u, '/kyc/start', {});
    await call(u, '/dev/kyc/complete', { birthdate: '1990-01-01', gender: 'male', country: 'DE' });
  }
  return u;
}
const event = (e: PaymentEventWire, secret = SECRET) => {
  const body = JSON.stringify(e);
  return app.inject({
    method: 'POST',
    url: '/internal/payments/events',
    headers: { 'content-type': 'application/json', 'x-wh-signature': signBody(secret, body) },
    payload: body,
  });
};

describe('пополнение', () => {
  it('гость — только после регистрации; зарегистрированному KYC не нужен', async () => {
    const g = (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json() as U;
    expect((await call(g, '/wallet/deposits', { amount: '10000000' })).body.error).toBe(
      'registration_required',
    );
    const u = await registered(false);
    gw.mode = 'ok';
    const r = await call(
      u,
      '/wallet/deposits',
      { amount: '10000000', rail: 'card' },
      { 'idempotency-key': 'client-key-1' },
    );
    expect(r.status).toBe(201);
    expect(r.body.checkoutUrl).toBe('http://gw.test/mock/checkout/x');
    expect(gw.calls.at(-1)).toMatchObject({
      path: '/v1/deposits',
      signed: true,
      key: `${u.userId}:client-key-1`,
      body: { userId: u.userId, amount: '10000000', currency: 'USDT', rail: 'card' },
    });
  });

  it('deposit.succeeded зачисляет ровно один раз; без подписи — 401', async () => {
    const u = await registered(false);
    const e: PaymentEventWire = {
      id: randomUUID(),
      type: 'deposit.succeeded',
      intentId: randomUUID(),
      userId: u.userId,
      ledgerAmount: '25000000',
    };
    expect((await event(e, 'x'.repeat(32))).statusCode).toBe(401);
    expect((await event(e)).statusCode).toBe(204);
    expect((await event({ ...e, id: randomUUID() })).statusCode).toBe(204); // повторная доставка
    expect((await usdt(u)).main).toBe(25_000_000n);
  });
});

describe('вывод', () => {
  const fund = async (u: U, amount: string) =>
    event({
      id: randomUUID(),
      type: 'deposit.succeeded',
      intentId: randomUUID(),
      userId: u.userId,
      ledgerAmount: amount,
    });

  it('только после KYC; деньги замораживаются до ответа шлюза; payout.succeeded списывает', async () => {
    const noKyc = await registered(false);
    expect(
      (await call(noKyc, '/wallet/withdrawals', { amount: '1000000', destination: 'TQ1234567890' }))
        .body.error,
    ).toBe('kyc_required');

    const u = await registered(true);
    await fund(u, '30000000');
    gw.mode = 'ok';
    const r = await call(u, '/wallet/withdrawals', {
      amount: '10000000',
      destination: 'TQ1234567890',
    });
    expect(r).toMatchObject({ status: 202, body: { status: 'sent' } });
    expect(gw.calls.at(-1)).toMatchObject({
      path: '/v1/payouts',
      signed: true,
      body: { payoutId: r.body.payoutId, amount: '10000000', rail: 'crypto' },
    });
    expect(await usdt(u)).toMatchObject({ main: 20_000_000n, pendingWithdrawal: 10_000_000n });

    await event({
      id: randomUUID(),
      type: 'payout.succeeded',
      payoutId: r.body.payoutId,
      userId: u.userId,
      amount: '10000000',
    });
    expect(await usdt(u)).toMatchObject({ main: 20_000_000n, pendingWithdrawal: 0n });
  });

  it('payout.failed и отказ шлюза возвращают деньги; недоступный шлюз — заявка ждёт', async () => {
    const u = await registered(true);
    await fund(u, '30000000');
    gw.mode = 'ok';
    const a = await call(u, '/wallet/withdrawals', {
      amount: '5000000',
      destination: 'TQ1234567890',
    });
    await event({
      id: randomUUID(),
      type: 'payout.failed',
      payoutId: a.body.payoutId,
      userId: u.userId,
      amount: '5000000',
      reason: 'aml',
    });
    expect(await usdt(u)).toMatchObject({ main: 30_000_000n, pendingWithdrawal: 0n });

    gw.mode = 'reject';
    const b = await call(u, '/wallet/withdrawals', {
      amount: '5000000',
      destination: 'TQ1234567890',
    });
    expect(b.body.error).toBe('gateway_no_provider_for_route');
    expect(await usdt(u)).toMatchObject({ main: 30_000_000n, pendingWithdrawal: 0n });

    gw.mode = 'down';
    const c = await call(u, '/wallet/withdrawals', {
      amount: '5000000',
      destination: 'TQ1234567890',
    });
    expect(c.body.status).toBe('pending');
    expect(await usdt(u)).toMatchObject({ main: 25_000_000n, pendingWithdrawal: 5_000_000n });

    gw.mode = 'ok';
    expect(
      (await call(u, '/wallet/withdrawals', { amount: '99000000', destination: 'TQ1234567890' }))
        .body.error,
    ).toBe('insufficient_funds');
  });
});
