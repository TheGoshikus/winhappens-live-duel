import { loadCoreConfig } from '@winhappens/config';
import {
  liveDealersResponseSchema,
  roundViewSchema,
  sessionViewSchema,
  walletResponseSchema,
  type RoundView,
  type SessionView,
} from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Db } from '../db/index.js';
import { MockOtpSender } from '../identity/otp.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import {
  createIdentityModule,
  createRoundModule,
  createVideoModule,
  createWalletModule,
} from '../wiring.js';
import { commitOf, type RoundService } from './service.js';
import { roundMessage } from './signer.js';

const config = loadCoreConfig(testEnv);
let app: FastifyInstance;
let db: Db;
let stop: () => Promise<void>;
let rounds: RoundService;
let now = new Date('2026-10-26T12:00:00Z');
const otp = new MockOtpSender();
const offline = new Set<string>();
const START = 100_000n; // 1000 фишек FUN в сотых
const S = 1000n; // ставка 10 фишек
const D = S * BigInt(config.game.roundsBuffer); // депозит сессии
const COST = 1022n; // ставка + сбор 2,29%

beforeAll(async () => {
  const t = await startTestDb();
  ({ db, stop } = t);
  const clock = () => now;
  const identity = createIdentityModule(db, config, { otp, clock });
  const wallet = createWalletModule(db, config);
  const r = createRoundModule(db, config, identity, wallet, {
    clock,
    isOnline: async (u) => !offline.has(u),
  });
  rounds = r.rounds;
  const video = createVideoModule(db, config, identity, {
    busy: () => rounds.busyDealers(),
    onOffline: (u) => rounds.endDealerSessions(u),
  });
  app = buildApp({ probes: {}, identity, wallet, video, rounds: r });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});
beforeEach(() => {
  now = new Date(now.getTime() + 3_600_000);
  offline.clear();
});

type U = { userId: string; accessToken: string };
const H = (u: U) => ({ authorization: `Bearer ${u.accessToken}` });
const call = async (u: U, method: 'GET' | 'POST', url: string, payload?: object) => {
  const r = await app.inject({ method, url, headers: H(u), ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const view = (b: unknown): RoundView => roundViewSchema.parse(b);
const sview = (b: unknown): SessionView => sessionViewSchema.parse(b);
let seq = 0;

async function dealer(): Promise<U> {
  const destination = `d${++seq}@example.com`;
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
  await call(u, 'POST', '/kyc/start');
  await call(u, 'POST', '/dev/kyc/complete', {
    birthdate: '1997-01-01',
    gender: 'female',
    country: 'DE',
  });
  expect(
    (
      await call(u, 'POST', '/dealer/live', {
        displayName: 'Алина',
        scene: 'lobby',
        minStake: '500',
      })
    ).status,
  ).toBe(200);
  return u;
}
const guest = async (): Promise<U> =>
  (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json();
const funOf = async (u: U) =>
  walletResponseSchema.parse((await call(u, 'GET', '/wallet')).body).FUN;
/** Всё, что принадлежит игроку: основной счёт + депозиты сессий. */
const total = async (u: U) => {
  const f = await funOf(u);
  return f.main + f.hold;
};
const startSession = async (p: U, d: U, stake = S) => {
  const r = await call(p, 'POST', '/sessions', { dealerId: d.userId, stake: stake.toString() });
  expect(r.status).toBe(201);
  return sview(r.body);
};
const sessionOf = async (u: U, id: string) => sview((await call(u, 'GET', `/sessions/${id}`)).body);

const salt = () => randomBytes(16).toString('hex');
async function commitBoth(p: U, d: U, id: string, pn: number, dn: number) {
  const ps = salt();
  const ds = salt();
  expect((await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(pn, ps) })).status).toBe(
    200,
  );
  expect(
    view((await call(d, 'POST', `/rounds/${id}/commit`, { commit: commitOf(dn, ds) })).body).status,
  ).toBe('reveal');
  return { ps, ds };
}
async function play(p: U, d: U, pn: number, dn: number, extra: object = {}) {
  const created = await call(p, 'POST', '/rounds', {
    dealerId: d.userId,
    stake: S.toString(),
    ...extra,
  });
  expect(created.status).toBe(201);
  const id = view(created.body).id;
  const { ps, ds } = await commitBoth(p, d, id, pn, dn);
  await call(p, 'POST', `/rounds/${id}/reveal`, { number: pn, salt: ps });
  return view((await call(d, 'POST', `/rounds/${id}/reveal`, { number: dn, salt: ds })).body);
}

describe('сессия', () => {
  it('депозит D = S × buffer у обоих; раунд берёт ставку из депозита, приз — на основной счёт', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    expect(s).toMatchObject({
      seat: 0,
      stake: S,
      deposit: D,
      holdLeft: D,
      opponentHoldLeft: D,
      status: 'active',
    });
    expect(Date.parse(s.endsAt) - Date.parse(s.startedAt)).toBe(
      config.game.sessionDurationSec * 1000,
    );
    expect((await funOf(p)).main).toBe(START - D);

    const done = await play(p, d, 1, 3);
    expect(done.result).toMatchObject({
      outcome: 'normal',
      winnerSeat: 0,
      prize: 1900n,
      winFee: 100n,
      stakeFee: 22n,
    });
    expect(await funOf(p)).toMatchObject({ main: START - D + 1900n, hold: D - COST });
    expect(await sessionOf(p, s.id)).toMatchObject({
      holdLeft: D - COST,
      opponentHoldLeft: D - COST,
    });
    expect(await total(d)).toBe(START - COST);

    // Подпись результата проверяется публичным ключом.
    const { publicKey } = (await call(p, 'GET', '/rounds/public-key')).body;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    const row = await rounds.peek(done.id);
    const msg = roundMessage({
      id: done.id,
      dealerId: d.userId,
      playerId: p.userId,
      currency: 'FUN',
      stake: S,
      item: null,
      playerCommit: row.player_commit,
      dealerCommit: row.dealer_commit,
      playerNumber: 1,
      dealerNumber: 3,
      outcome: 'normal',
      winnerSeat: 0,
      prize: 1900n,
      winFee: 100n,
    });
    expect(verify(null, Buffer.from(msg), key, Buffer.from(done.result!.signature, 'base64'))).toBe(
      true,
    );

    // Выход: остаток депозита возвращается.
    const left = sview((await call(p, 'POST', `/sessions/${s.id}/leave`)).body);
    expect(left).toMatchObject({ status: 'ended', endReason: 'player_left' });
    expect(await funOf(p)).toMatchObject({ main: START - COST + 1900n, hold: 0n });
  });

  it('проверки: мин. ставка стола, раунд без сессии, ставка ≠ сессии, чужой раунд, повторы, неверное раскрытие', async () => {
    const [d, p, stranger] = [await dealer(), await guest(), await guest()];
    expect(
      (await call(p, 'POST', '/sessions', { dealerId: d.userId, stake: '100' })).body.error,
    ).toBe('stake_below_table_min');
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body.error,
    ).toBe('no_active_session');
    await startSession(p, d);
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '2000' })).body.error,
    ).toBe('stake_must_match_session');
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body.error,
    ).toBe('round_in_progress');
    expect((await call(stranger, 'GET', `/rounds/${id}`)).status).toBe(404);
    const s1 = salt();
    await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(4, s1) });
    expect(
      (await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(4, s1) })).body.error,
    ).toBe('already_committed');
    expect(
      (await call(p, 'POST', `/rounds/${id}/reveal`, { number: 4, salt: s1 })).body.error,
    ).toBe('not_in_reveal_phase');
    await call(d, 'POST', `/rounds/${id}/commit`, { commit: commitOf(5, salt()) });
    expect(
      (await call(p, 'POST', `/rounds/${id}/reveal`, { number: 5, salt: s1 })).body.error,
    ).toBe('reveal_mismatch');
  });

  it('крупье занята сессией: второй игрок получает отказ, в ленте busy', async () => {
    const [d, p1, p2] = [await dealer(), await guest(), await guest()];
    await startSession(p1, d);
    expect(
      (await call(p2, 'POST', '/sessions', { dealerId: d.userId, stake: '1000' })).body.error,
    ).toBe('dealer_busy');
    const list = liveDealersResponseSchema.parse((await call(p2, 'GET', '/dealers')).body);
    expect(list.dealers.find((x) => x.id === d.userId)?.busy).toBe(true);
  });

  it('игрок ведёт сессии у разных крупье параллельно; депозиты не смешиваются; на третью не хватает', async () => {
    const [d1, d2, d3, p] = [await dealer(), await dealer(), await dealer(), await guest()];
    const big = 10_000n; // D = 50 000
    const s1 = await startSession(p, d1, big);
    await startSession(p, d2, big);
    expect(
      (await call(p, 'POST', '/sessions', { dealerId: d3.userId, stake: big.toString() })).body
        .error,
    ).toBe('insufficient_funds');
    expect(await funOf(p)).toMatchObject({ main: 0n, hold: 100_000n });
    await call(p, 'POST', `/sessions/${s1.id}/leave`);
    // Вернулся ровно депозит первой сессии — вторая не тронута.
    expect(await funOf(p)).toMatchObject({ main: 50_000n, hold: 50_000n });
  });

  it('депозита не хватает на следующий раунд — сессия заканчивается сама', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    for (let i = 0; i < 4; i++) await play(p, d, 2, 3); // 4 проигрыша
    const after = await sessionOf(p, s.id);
    expect(after).toMatchObject({ status: 'ended', endReason: 'deposit_exhausted' });
    expect(await funOf(p)).toMatchObject({ main: START - 4n * COST, hold: 0n });
  });

  it('5:00 — время вышло: идущий раунд доигрывается, затем сессия закрывается', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    // Раунд начат за 5 с до конца сессии — раскрытие ещё в пределах таймаута.
    now = new Date(Date.parse(s.endsAt) - 5_000);
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    const { ps, ds } = await commitBoth(p, d, id, 0, 2);
    now = new Date(Date.parse(s.endsAt) + 1000);
    await rounds.sweep();
    expect((await sessionOf(p, s.id)).status).toBe('active'); // раунд ещё открыт
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body.error,
    ).toBe('no_active_session');
    await call(p, 'POST', `/rounds/${id}/reveal`, { number: 0, salt: ps });
    await call(d, 'POST', `/rounds/${id}/reveal`, { number: 2, salt: ds });
    expect(await sessionOf(p, s.id)).toMatchObject({ status: 'ended', endReason: 'time_over' });
    expect(await funOf(p)).toMatchObject({ hold: 0n, main: START - COST + 1900n });
  });

  it('выход: до обоих коммитов — отмена с возвратом; после — не раскрывшийся ушедший проигрывает', async () => {
    const [d, p] = [await dealer(), await guest()];
    let s = await startSession(p, d);
    const a = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    await call(p, 'POST', `/rounds/${a}/commit`, { commit: commitOf(1, salt()) });
    await call(p, 'POST', `/sessions/${s.id}/leave`);
    expect(view((await call(p, 'GET', `/rounds/${a}`)).body).status).toBe('cancelled');
    expect(await total(p)).toBe(START);

    s = await startSession(p, d);
    const b = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    await commitBoth(p, d, b, 2, 3);
    await call(d, 'POST', `/sessions/${s.id}/leave`); // крупье ушла после коммита, не раскрывшись
    expect(view((await call(p, 'GET', `/rounds/${b}`)).body).result).toMatchObject({
      outcome: 'forfeit',
      winnerSeat: 0,
    });
    expect(await sessionOf(p, s.id)).toMatchObject({ status: 'ended', endReason: 'dealer_left' });
    expect(await total(p)).toBe(START - COST + 1900n);
  });

  it('отключение: офлайн отмечается, через reconnectGraceSec — выход; вернулся раньше — сессия живёт', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    offline.add(p.userId);
    await rounds.sweep();
    expect((await sessionOf(d, s.id)).opponentOfflineAt).not.toBeNull();
    offline.delete(p.userId);
    now = new Date(now.getTime() + 10_000);
    await rounds.sweep();
    expect((await sessionOf(d, s.id)).opponentOfflineAt).toBeNull();

    offline.add(p.userId);
    await rounds.sweep();
    now = new Date(now.getTime() + (config.game.reconnectGraceSec + 1) * 1000);
    await rounds.sweep();
    expect(await sessionOf(d, s.id)).toMatchObject({
      status: 'ended',
      endReason: 'player_disconnected',
    });
    expect(await total(p)).toBe(START);
  });

  it('крупье уходит из эфира — её сессия завершается', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    await call(d, 'POST', '/dealer/offline');
    expect(await sessionOf(p, s.id)).toMatchObject({ status: 'ended', endReason: 'dealer_left' });
    expect((await funOf(p)).hold).toBe(0n);
  });
});

describe('раунд', () => {
  it('таймаут раскрытия — проигрыш не раскрывшемуся (forfeit) фоновым обработчиком', async () => {
    const [d, p] = [await dealer(), await guest()];
    await startSession(p, d);
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    const { ps } = await commitBoth(p, d, id, 7, 2);
    await call(p, 'POST', `/rounds/${id}/reveal`, { number: 7, salt: ps });
    now = new Date(now.getTime() + (config.game.revealTimeoutSec + 1) * 1000);
    await rounds.sweep();
    expect(view((await call(p, 'GET', `/rounds/${id}`)).body).result).toMatchObject({
      outcome: 'forfeit',
      winnerSeat: 0,
      dealerNumber: null,
    });
  });

  it('крупье не успела закоммитить — отмена, ставка со сбором вернулась в депозит', async () => {
    const [d, p] = [await dealer(), await guest()];
    const s = await startSession(p, d);
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(1, salt()) });
    expect((await sessionOf(p, s.id)).holdLeft).toBe(D - COST);
    now = new Date(now.getTime() + (config.game.seatHoldSec + 1) * 1000);
    expect(view((await call(p, 'GET', `/rounds/${id}`)).body).status).toBe('cancelled');
    expect((await sessionOf(p, s.id)).holdLeft).toBe(D);
  });

  it('взаимность: после 3 раундов, ставка = цена предмета, 20% с выигрыша, предмет снимается один раз', async () => {
    const [d, p] = [await dealer(), await guest()];
    await startSession(p, d, 1000n);
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000', item: 'scarf' })).body
        .error,
    ).toBe('reciprocity_locked');
    for (let i = 0; i < 3; i++) await play(p, d, 1, 3);
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '500', item: 'scarf' })).body
        .error,
    ).toBe('stake_must_match_item');
    const done = await play(p, d, 1, 3, { item: 'scarf' });
    expect(done.result).toMatchObject({ winnerSeat: 0, prize: 1800n, winFee: 200n });
    expect((await call(p, 'GET', `/dealers/${d.userId}/progress`)).body).toEqual({
      rounds: 4,
      removed: ['scarf'],
    });
  });

  it('журнал: завершённый раунд нельзя изменить; крупье видит свои раунды', async () => {
    const [d, p] = [await dealer(), await guest()];
    await startSession(p, d);
    const done = await play(p, d, 0, 2);
    await expect(
      sql`update duel_round set prize = 1 where id = ${done.id}`.execute(db),
    ).rejects.toThrow(/final/);
    const list = (await call(d, 'GET', '/dealer/rounds')).body.rounds.map(view);
    expect(list[0]).toMatchObject({ id: done.id, seat: 1, status: 'settled' });
  });
});
