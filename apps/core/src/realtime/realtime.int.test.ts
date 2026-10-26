import { loadCoreConfig } from '@winhappens/config';
import { serverEventSchema, type ServerEvent } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MockOtpSender } from '../identity/otp.js';
import { commitOf } from '../rounds/service.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import {
  createIdentityModule,
  createRoundModule,
  createVideoModule,
  createWalletModule,
} from '../wiring.js';
import { createLocalBus } from './bus.js';
import { createNotifier } from './notifier.js';
import { createMemoryPresence } from './presence.js';

const config = loadCoreConfig(testEnv);
let app: FastifyInstance;
let stop: () => Promise<void>;
let base: string;
const presence = createMemoryPresence();
const otp = new MockOtpSender();

beforeAll(async () => {
  const t = await startTestDb();
  stop = t.stop;
  const bus = createLocalBus();
  const identity = createIdentityModule(t.db, config, { otp });
  const wallet = createWalletModule(t.db, config);
  const notifier = createNotifier(bus, wallet.wallet);
  const rounds = createRoundModule(t.db, config, identity, wallet, {
    emit: (ch, svc) => notifier.changes(ch, svc),
  });
  const video = createVideoModule(t.db, config, identity, {
    busy: () => rounds.rounds.busyDealers(),
    onTablesChanged: () => notifier.tablesChanged(),
  });
  app = buildApp({
    probes: {},
    identity,
    wallet,
    rounds,
    video,
    realtime: { bus, presence, tokens: identity.tokens },
  });
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  base = addr.replace('http', 'ws');
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});

type U = { userId: string; accessToken: string };
const H = (u: U) => ({ authorization: `Bearer ${u.accessToken}` });
const post = async (u: U, url: string, payload?: object) =>
  (
    await app.inject({ method: 'POST', url, headers: H(u), ...(payload ? { payload } : {}) })
  ).json();
const guest = async (): Promise<U> =>
  (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json();
async function dealer(): Promise<U> {
  const destination = `ws${Date.now()}${Math.random()}@example.com`;
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
      payload: { challengeId, code: otp.lastCodeFor(destination) },
    })
  ).json() as U;
  await post(u, '/kyc/start');
  await app.inject({
    method: 'POST',
    url: '/dev/kyc/complete',
    headers: H(u),
    payload: { birthdate: '1997-01-01', gender: 'female', country: 'DE' },
  });
  await post(u, '/dealer/live', { displayName: 'Алина', scene: 'lobby', minStake: '500' });
  return u;
}

/** Клиент WS: копит события, ждёт нужное. */
function client(token: string | null) {
  const ws = new WebSocket(`${base}/ws`);
  const events: ServerEvent[] = [];
  const waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
  let closeCode: number | null = null;
  ws.addEventListener('open', () => token && ws.send(JSON.stringify({ type: 'auth', token })));
  ws.addEventListener('message', (m) => {
    const e = serverEventSchema.parse(JSON.parse(String(m.data)));
    events.push(e);
    for (const w of [...waiters]) {
      if (!w.pred(e)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  });
  const closed = new Promise<number>((r) =>
    ws.addEventListener('close', (e) => r((closeCode = e.code))),
  );
  return {
    ws,
    events,
    closed,
    get closeCode() {
      return closeCode;
    },
    next<T extends ServerEvent['type']>(
      type: T,
      pred: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true,
      timeout = 5000,
    ) {
      const hit = events.find(
        (e) => e.type === type && pred(e as Extract<ServerEvent, { type: T }>),
      );
      if (hit) return Promise.resolve(hit as Extract<ServerEvent, { type: T }>);
      return new Promise<Extract<ServerEvent, { type: T }>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no ${type} event`)), timeout);
        waiters.push({
          pred: (e) => e.type === type && pred(e as Extract<ServerEvent, { type: T }>),
          resolve: (e) => (clearTimeout(t), resolve(e as Extract<ServerEvent, { type: T }>)),
        });
      });
    },
  };
}

describe('WS-шлюз', () => {
  it('без токена или с битым — закрытие 4001; с токеном — ready и присутствие', async () => {
    const bad = client('x'.repeat(20));
    expect(await bad.closed).toBe(4001);
    const g = await guest();
    const c = client(g.accessToken);
    expect((await c.next('ready')).userId).toBe(g.userId);
    expect(await presence.isOnline(g.userId)).toBe(true);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(await presence.isOnline(g.userId)).toBe(false);
  });

  it('сессия и раунд приходят событиями обоим, без опроса; кошелёк обновляется', async () => {
    const [d, p, other] = [await dealer(), await guest(), await guest()];
    const [cd, cp, co] = [client(d.accessToken), client(p.accessToken), client(other.accessToken)];
    await Promise.all([cd.next('ready'), cp.next('ready'), co.next('ready')]);

    const session = await post(p, '/sessions', { dealerId: d.userId, stake: '1000' });
    expect(
      (await cd.next('session.updated', (e) => e.session.id === session.id)).session,
    ).toMatchObject({ seat: 1, status: 'active' });
    // Остальные узнают, что стол занят.
    await co.next('dealers.updated');
    expect((await cp.next('wallet.updated')).FUN.hold).toBe(5000n);

    const round = await post(p, '/rounds', { dealerId: d.userId, stake: '1000' });
    const incoming = await cd.next('round.updated', (e) => e.round.id === round.id);
    expect(incoming.round).toMatchObject({
      seat: 1,
      status: 'commit',
      committed: { player: false, dealer: false },
    });

    const [ps, ds] = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
    await post(p, `/rounds/${round.id}/commit`, { commit: commitOf(1, ps) });
    await cd.next('round.updated', (e) => e.round.committed.player);
    await post(d, `/rounds/${round.id}/commit`, { commit: commitOf(3, ds) });
    await cp.next('round.updated', (e) => e.round.status === 'reveal');
    await post(p, `/rounds/${round.id}/reveal`, { number: 1, salt: ps });
    await post(d, `/rounds/${round.id}/reveal`, { number: 3, salt: ds });
    const done = await cp.next('round.updated', (e) => e.round.status === 'settled');
    expect(done.round.result).toMatchObject({
      winnerSeat: 0,
      playerNumber: 1,
      dealerNumber: 3,
      prize: 1900n,
    });
    expect(
      (await cp.next('wallet.updated', (e) => e.FUN.main === 100_000n - 5000n + 1900n)).FUN.hold,
    ).toBe(5000n - 1022n);
    // Посторонний раундов не видит.
    expect(co.events.some((e) => e.type === 'round.updated')).toBe(false);
    for (const c of [cd, cp, co]) c.ws.close();
  });
});
