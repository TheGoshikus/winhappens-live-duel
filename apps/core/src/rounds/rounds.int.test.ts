import { loadCoreConfig } from '@winhappens/config';
import { roundViewSchema, walletResponseSchema, type RoundView } from '@winhappens/shared';
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
const START = 100_000n; // 1000 фишек FUN в сотых

beforeAll(async () => {
  const t = await startTestDb();
  ({ db, stop } = t);
  const clock = () => now;
  const identity = createIdentityModule(db, config, { otp, clock });
  const wallet = createWalletModule(db, config);
  const r = createRoundModule(db, config, identity, wallet, clock);
  rounds = r.rounds;
  app = buildApp({
    probes: {},
    identity,
    wallet,
    video: createVideoModule(db, config, identity),
    rounds: r,
  });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});
beforeEach(() => {
  now = new Date(now.getTime() + 3_600_000);
});

type U = { userId: string; accessToken: string };
const H = (u: U) => ({ authorization: `Bearer ${u.accessToken}` });
const call = async (u: U, method: 'GET' | 'POST', url: string, payload?: object) => {
  const r = await app.inject({ method, url, headers: H(u), ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const view = (b: unknown): RoundView => roundViewSchema.parse(b);
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
const fun = async (u: U) =>
  walletResponseSchema.parse((await call(u, 'GET', '/wallet')).body).FUN.main;

const salt = () => randomBytes(16).toString('hex');
async function commitBoth(p: U, d: U, id: string, pn: number, dn: number) {
  const ps = salt();
  const ds = salt();
  expect((await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(pn, ps) })).status).toBe(
    200,
  );
  const afterBoth = view(
    (await call(d, 'POST', `/rounds/${id}/commit`, { commit: commitOf(dn, ds) })).body,
  );
  expect(afterBoth.status).toBe('reveal');
  return { ps, ds };
}
async function play(p: U, d: U, pn: number, dn: number, extra: object = {}) {
  const created = await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000', ...extra });
  expect(created.status).toBe(201);
  const id = view(created.body).id;
  const { ps, ds } = await commitBoth(p, d, id, pn, dn);
  await call(p, 'POST', `/rounds/${id}/reveal`, { number: pn, salt: ps });
  return view((await call(d, 'POST', `/rounds/${id}/reveal`, { number: dn, salt: ds })).body);
}

describe('раунд игрок ↔ крупье', () => {
  it('чётная сумма — победа игрока: сбор 2,29% с обоих, 10% с выигрыша, подпись проверяется', async () => {
    const [d, p] = [await dealer(), await guest()];
    const created = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    );
    expect(created).toMatchObject({
      seat: 0,
      status: 'commit',
      currency: 'FUN',
      stake: 1000n,
      result: null,
    });

    const { ps, ds } = await commitBoth(p, d, created.id, 1, 3);
    // Деньги уже в банке: ставка + сбор.
    expect(await fun(p)).toBe(START - 1022n);
    const half = view(
      (await call(p, 'POST', `/rounds/${created.id}/reveal`, { number: 1, salt: ps })).body,
    );
    expect(half.result).toBeNull(); // число крупье не видно до расчёта
    const done = view(
      (await call(d, 'POST', `/rounds/${created.id}/reveal`, { number: 3, salt: ds })).body,
    );
    expect(done).toMatchObject({ seat: 1, status: 'settled' });
    expect(done.result).toMatchObject({
      outcome: 'normal',
      playerNumber: 1,
      dealerNumber: 3,
      winnerSeat: 0,
      prize: 1900n,
      winFee: 100n,
      stakeFee: 22n,
    });

    expect(await fun(p)).toBe(START - 1022n + 1900n);
    expect(await fun(d)).toBe(START - 1022n);

    const { publicKey } = (await call(p, 'GET', '/rounds/public-key')).body;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    const msg = roundMessage({
      id: done.id,
      dealerId: d.userId,
      playerId: p.userId,
      currency: 'FUN',
      stake: 1000n,
      item: null,
      playerCommit: commitOf(1, ps),
      dealerCommit: commitOf(3, ds),
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
    expect(
      verify(
        null,
        Buffer.from(msg.replace('1900', '9999')),
        key,
        Buffer.from(done.result!.signature, 'base64'),
      ),
    ).toBe(false);
  });

  it('нечётная сумма — победа крупье', async () => {
    const [d, p] = [await dealer(), await guest()];
    const done = await play(p, d, 2, 3);
    expect(done.result).toMatchObject({ winnerSeat: 1, prize: 1900n });
    expect(await fun(p)).toBe(START - 1022n);
    expect(await fun(d)).toBe(START - 1022n + 1900n);
  });

  it('проверки: чужой раунд, повторный коммит, неверное раскрытие, один раунд на пару, мин. ставка', async () => {
    const [d, p, stranger] = [await dealer(), await guest(), await guest()];
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '100' })).body.error,
    ).toBe('stake_below_table_min');
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

  it('не раскрылась крупье за T — проигрыш ей (forfeit), срабатывает и фоновым обработчиком', async () => {
    const [d, p] = [await dealer(), await guest()];
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    const { ps } = await commitBoth(p, d, id, 7, 2);
    await call(p, 'POST', `/rounds/${id}/reveal`, { number: 7, salt: ps });
    now = new Date(now.getTime() + (config.game.revealTimeoutSec + 1) * 1000);
    // Обработчик закрывает и другие просроченные раунды (из прошлых тестов).
    expect(await rounds.sweep()).toBeGreaterThanOrEqual(1);
    const r = view((await call(p, 'GET', `/rounds/${id}`)).body);
    expect(r.result).toMatchObject({
      outcome: 'forfeit',
      winnerSeat: 0,
      playerNumber: 7,
      dealerNumber: null,
    });
    expect(await fun(p)).toBe(START - 1022n + 1900n);
  });

  it('крупье не успела закоммитить — раунд отменён, ставка и сбор вернулись', async () => {
    const [d, p] = [await dealer(), await guest()];
    const id = view(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000' })).body,
    ).id;
    await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(1, salt()) });
    expect(await fun(p)).toBe(START - 1022n);
    now = new Date(now.getTime() + (config.game.seatHoldSec + 1) * 1000);
    expect(view((await call(p, 'GET', `/rounds/${id}`)).body).status).toBe('cancelled');
    expect(await fun(p)).toBe(START);
    expect(
      (await call(d, 'POST', `/rounds/${id}/commit`, { commit: commitOf(1, salt()) })).body.error,
    ).toBe('not_in_commit_phase');
  });

  it('не хватает денег на ставку со сбором — коммит отклонён, деньги не тронуты', async () => {
    const [d, p] = [await dealer(), await guest()];
    // 9 проигрышей по 100 фишек (максимум FUN): остаётся 79,39 < 100 + 2,29.
    const stake = { stake: '10000' };
    for (let i = 0; i < 9; i++) {
      const id = view((await call(p, 'POST', '/rounds', { dealerId: d.userId, ...stake })).body).id;
      const { ps, ds } = await commitBoth(p, d, id, 2, 3);
      await call(p, 'POST', `/rounds/${id}/reveal`, { number: 2, salt: ps });
      await call(d, 'POST', `/rounds/${id}/reveal`, { number: 3, salt: ds });
    }
    const left = START - 9n * 10_229n;
    expect(await fun(p)).toBe(left);
    const id = view((await call(p, 'POST', '/rounds', { dealerId: d.userId, ...stake })).body).id;
    const fail = await call(p, 'POST', `/rounds/${id}/commit`, { commit: commitOf(1, salt()) });
    expect(fail).toMatchObject({ status: 409, body: { error: 'insufficient_funds' } });
    expect(view((await call(p, 'GET', `/rounds/${id}`)).body).committed.player).toBe(false);
    expect(await fun(p)).toBe(left);
  });

  it('взаимность: после 3 раундов, ставка = цена предмета, 20% с выигрыша, предмет снимается один раз', async () => {
    const [d, p] = [await dealer(), await guest()];
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
    expect(done.item).toBe('scarf');
    expect(done.result).toMatchObject({ winnerSeat: 0, prize: 1800n, winFee: 200n });
    expect((await call(p, 'GET', `/dealers/${d.userId}/progress`)).body).toEqual({
      rounds: 4,
      removed: ['scarf'],
    });
    expect(
      (await call(p, 'POST', '/rounds', { dealerId: d.userId, stake: '1000', item: 'scarf' })).body
        .error,
    ).toBe('item_removed');
  });

  it('журнал: завершённый раунд нельзя изменить; крупье видит свои раунды', async () => {
    const [d, p] = [await dealer(), await guest()];
    const done = await play(p, d, 0, 2);
    await expect(
      sql`update duel_round set prize = 1 where id = ${done.id}`.execute(db),
    ).rejects.toThrow(/final/);
    const list = (await call(d, 'GET', '/dealer/rounds')).body.rounds.map(view);
    expect(list[0]).toMatchObject({ id: done.id, seat: 1, status: 'settled' });
  });
});
