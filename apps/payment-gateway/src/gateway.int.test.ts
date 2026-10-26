import { depositSessionSchema, paymentEventSchema } from '@winhappens/shared';
import { signBody, verifyBody } from '@winhappens/shared/server';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAdapter } from './adapters/mock.js';
import { buildApp } from './app.js';
import type { Db } from './db/index.js';
import { createGateway, ledgerAmountOf, type Gateway } from './service.js';
import { startTestDb } from './test/postgres.js';

const SECRET = 'g'.repeat(32);
let app: FastifyInstance;
let db: Db;
let stop: () => Promise<void>;
let gateway: Gateway;
const mock = new MockAdapter({ publicUrl: 'http://gw.test', secret: 'mock-secret-mock-secret' });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  gateway = createGateway(db, [mock], {
    payoutReviewThreshold: 100_000_000n,
    fxEurUsdt: '1.08',
    coreEventsUrl: 'http://core.test/internal/payments/events',
    secret: SECRET,
  });
  app = buildApp({
    probes: {},
    routes: { gateway, secret: SECRET, mock, autoSettleMockPayouts: false },
  });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});

/** Запрос core → gateway с подписью. */
async function core(
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  const raw = body ? JSON.stringify(body) : '';
  const signed = method === 'GET' ? `GET ${url}` : raw;
  const r = await app.inject({
    method,
    url,
    headers: {
      'content-type': 'application/json',
      'x-wh-signature': signBody(SECRET, signed),
      ...headers,
    },
    ...(body ? { payload: raw } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}
const deposit = (userId: string, amount: string, extra: object = {}, key = randomUUID()) =>
  core(
    'POST',
    '/v1/deposits',
    { userId, amount, currency: 'USDT', rail: 'card', ...extra },
    { 'idempotency-key': key },
  );
const webhook = (raw: { body: string; headers: Record<string, unknown> }) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/mock',
    headers: { 'content-type': 'application/json', ...(raw.headers as Record<string, string>) },
    payload: raw.body,
  });
const outbox = async () =>
  (await db.selectFrom('outbox').selectAll().orderBy('created_at').execute()).map((r) =>
    paymentEventSchema.parse(r.payload),
  );

describe('котировка', () => {
  it('EUR → USDT по зафиксированному курсу, USDT — 1:1', () => {
    expect(ledgerAmountOf(5_000n, 'EUR', '1.08')).toEqual({ ledger: 54_000_000n, rate: '1.08' });
    expect(ledgerAmountOf(1n, 'EUR', '1.083333')).toEqual({ ledger: 10_833n, rate: '1.083333' });
    expect(ledgerAmountOf(7_000_000n, 'USDT', '1.08')).toEqual({ ledger: 7_000_000n, rate: '1' });
  });
});

describe('внутренний API', () => {
  it('без подписи или с чужим секретом — 401', async () => {
    const body = JSON.stringify({
      userId: randomUUID(),
      amount: '1',
      currency: 'USDT',
      rail: 'card',
    });
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/deposits',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-12345678' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/deposits',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'k-12345678',
        'x-wh-signature': signBody('x'.repeat(32), body),
      },
      payload: body,
    });
    expect(wrong.statusCode).toBe(401);
  });
});

describe('депозит', () => {
  it('создаётся идемпотентно; оплата на mock-странице → deposit.succeeded в outbox ровно один раз', async () => {
    const user = randomUUID();
    const key = randomUUID();
    const a = depositSessionSchema.parse((await deposit(user, '25000000', {}, key)).body);
    const b = depositSessionSchema.parse((await deposit(user, '25000000', {}, key)).body);
    expect(b.intentId).toBe(a.intentId);
    expect(a).toMatchObject({ status: 'pending', ledgerAmount: 25_000_000n, address: null });
    expect(a.checkoutUrl).toBe(`http://gw.test/mock/checkout/mock_dep_${a.intentId}`);

    const page = await app.inject({ method: 'GET', url: `/mock/checkout/mock_dep_${a.intentId}` });
    expect(page.body).toContain('25.00 USDT');
    const paid = await app.inject({
      method: 'POST',
      url: `/mock/checkout/mock_dep_${a.intentId}/pay`,
    });
    expect(paid.statusCode).toBe(303);
    expect(
      depositSessionSchema.parse((await core('GET', `/v1/deposits/${a.intentId}`)).body).status,
    ).toBe('succeeded');

    // Повтор того же вебхука провайдера — дубль, второго события нет.
    const raw = mock.signedEvent({
      eventId: 'evt-dup-1',
      kind: 'deposit',
      providerRef: `mock_dep_${a.intentId}`,
      status: 'succeeded',
    });
    expect((await webhook(raw)).json()).toEqual({ result: 'ignored' }); // уже succeeded
    expect((await webhook(raw)).json()).toEqual({ result: 'duplicate' });
    const events = (await outbox()).filter(
      (e) => e.type === 'deposit.succeeded' && e.intentId === a.intentId,
    );
    expect(events).toEqual([expect.objectContaining({ userId: user, ledgerAmount: 25_000_000n })]);
  });

  it('EUR конвертируется по курсу; крипто-депозит получает адрес; отказ → deposit.failed', async () => {
    const user = randomUUID();
    const eur = depositSessionSchema.parse((await deposit(user, '5000', { currency: 'EUR' })).body);
    expect(eur.ledgerAmount).toBe(54_000_000n);
    const crypto = depositSessionSchema.parse(
      (await deposit(user, '1000000', { rail: 'crypto' })).body,
    );
    expect(crypto.address).toMatch(/^T[0-9a-f]{32}$/);
    await app.inject({ method: 'POST', url: `/mock/checkout/mock_dep_${eur.intentId}/decline` });
    expect(
      (await outbox()).some((e) => e.type === 'deposit.failed' && e.intentId === eur.intentId),
    ).toBe(true);
  });

  it('вебхук с неверной подписью — 401', async () => {
    const raw = mock.signedEvent({
      kind: 'deposit',
      providerRef: 'mock_dep_x',
      status: 'succeeded',
    });
    expect(
      (
        await webhook({
          body: raw.body,
          headers: { 'x-mock-signature': 't=1,v1=' + '0'.repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('выплата', () => {
  it('ниже порога — сразу провайдеру; вебхук → payout.succeeded; повтор запроса идемпотентен', async () => {
    const payoutId = randomUUID();
    const q = {
      payoutId,
      userId: randomUUID(),
      amount: '50000000',
      rail: 'crypto',
      destination: 'TQ1234567890',
    };
    expect((await core('POST', '/v1/payouts', q)).body).toEqual({ payoutId, status: 'sent' });
    expect((await core('POST', '/v1/payouts', q)).body).toEqual({ payoutId, status: 'sent' });
    await webhook(
      mock.signedEvent({
        kind: 'payout',
        providerRef: `mock_pay_${payoutId}`,
        status: 'succeeded',
      }),
    );
    expect(
      (await outbox()).filter((e) => e.type === 'payout.succeeded' && e.payoutId === payoutId),
    ).toHaveLength(1);
  });

  it('выше порога — на проверку; отклонение → payout.failed; одобрение → отправка', async () => {
    const big = (id: string) => ({
      payoutId: id,
      userId: randomUUID(),
      amount: '150000000',
      rail: 'crypto',
      destination: 'TQ1234567890',
    });
    const [r1, r2] = [randomUUID(), randomUUID()];
    expect((await core('POST', '/v1/payouts', big(r1))).body.status).toBe('review');
    expect(
      (await core('POST', `/v1/payouts/${r1}/review`, { approve: false, reason: 'aml_check' })).body
        .status,
    ).toBe('failed');
    expect(
      (await outbox()).find((e) => e.type === 'payout.failed' && e.payoutId === r1),
    ).toMatchObject({ reason: 'aml_check', amount: 150_000_000n });
    await core('POST', '/v1/payouts', big(r2));
    expect((await core('POST', `/v1/payouts/${r2}/review`, { approve: true })).body.status).toBe(
      'sent',
    );
    expect((await core('POST', `/v1/payouts/${r2}/review`, { approve: true })).body.error).toBe(
      'payout_not_in_review',
    );
  });
});

describe('outbox', () => {
  it('доставляет подписанные события; при ошибке core — повтор позже', async () => {
    await db
      .updateTable('outbox')
      .set({ delivered_at: new Date() })
      .where('delivered_at', 'is', null)
      .execute();
    const a = depositSessionSchema.parse((await deposit(randomUUID(), '1000000')).body);
    await app.inject({ method: 'POST', url: `/mock/checkout/mock_dep_${a.intentId}/pay` });

    const failing = (async () => new Response('down', { status: 503 })) as typeof fetch;
    expect(await gateway.deliverOutbox(failing)).toBe(0);
    const pending = await db
      .selectFrom('outbox')
      .selectAll()
      .where('delivered_at', 'is', null)
      .execute();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ attempts: 1, last_error: 'HTTP 503' });
    expect(pending[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(await gateway.deliverOutbox(failing)).toBe(0); // ещё рано — не трогаем

    await db
      .updateTable('outbox')
      .set({ next_attempt_at: new Date(0) })
      .where('delivered_at', 'is', null)
      .execute();
    const seen: { body: string; sig: string | null }[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      seen.push({ body: String(init.body), sig: new Headers(init.headers).get('x-wh-signature') });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    expect(await gateway.deliverOutbox(ok)).toBe(1);
    expect(verifyBody(SECRET, seen[0]!.body, seen[0]!.sig ?? undefined)).toBe(true);
    expect(paymentEventSchema.parse(JSON.parse(seen[0]!.body))).toMatchObject({
      type: 'deposit.succeeded',
      intentId: a.intentId,
    });
    expect(await gateway.deliverOutbox(ok)).toBe(0);
  });
});
