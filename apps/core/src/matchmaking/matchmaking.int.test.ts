import { loadCoreConfig } from '@winhappens/config';
import {
  feedResponseSchema,
  matchViewSchema,
  shiftViewSchema,
  type MatchView,
  type ShiftView,
} from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Db } from '../db/index.js';
import { MockOtpSender } from '../identity/otp.js';
import type { RoundService } from '../rounds/service.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import {
  createIdentityModule,
  createMatchModule,
  createRoundModule,
  createVideoModule,
  createWalletModule,
} from '../wiring.js';
import type { Matchmaking } from './service.js';

// Тесты смены сдвигают часы на десятки минут — токен не должен истечь посреди теста.
const config = loadCoreConfig({ ...testEnv, ACCESS_TOKEN_TTL_SEC: '86400' });
let app: FastifyInstance;
let stop: () => Promise<void>;
let db: Db;
let rounds: RoundService;
let mm: Matchmaking;
let now = new Date('2026-10-27T12:00:00Z');
const otp = new MockOtpSender();

beforeAll(async () => {
  const t = await startTestDb();
  stop = t.stop;
  db = t.db;
  const clock = () => now;
  const identity = createIdentityModule(t.db, config, { otp, clock });
  const wallet = createWalletModule(t.db, config);
  const r = createRoundModule(t.db, config, identity, wallet, { clock });
  rounds = r.rounds;
  const video = createVideoModule(t.db, config, identity, {
    busy: () => rounds.busyDealers(),
    onOffline: (u) => rounds.endDealerSessions(u),
  });
  const matchmaking = createMatchModule(t.db, config, identity, wallet, r, { clock });
  mm = matchmaking.matchmaking;
  app = buildApp({ probes: {}, identity, wallet, video, rounds: r, matchmaking });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});
beforeEach(async () => {
  now = new Date(now.getTime() + 3_600_000);
});

type U = { userId: string; accessToken: string };
const H = (u: U) => ({ authorization: `Bearer ${u.accessToken}` });
const call = async (u: U, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
  const r = await app.inject({ method, url, headers: H(u), ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const mv = (b: unknown): MatchView => matchViewSchema.parse(b);
const sv = (b: unknown): ShiftView => shiftViewSchema.parse(b);
let seq = 0;
const live: U[] = [];

async function registered(gender: 'female' | 'male'): Promise<U> {
  const destination = `m${++seq}@example.com`;
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
  await call(u, 'POST', '/dev/kyc/complete', { birthdate: '1995-01-01', gender, country: 'DE' });
  return u;
}
async function dealer(autoAccept = true): Promise<U> {
  const u = await registered('female');
  expect(
    (
      await call(u, 'POST', '/dealer/live', {
        displayName: `Крупье ${seq}`,
        scene: 'lobby',
        minStake: '500',
      })
    ).status,
  ).toBe(200);
  await call(u, 'PATCH', '/dealer/settings', { autoAccept });
  await call(u, 'GET', '/wallet');
  live.push(u);
  now = new Date(now.getTime() + 1000); // went_live_at различаются — порядок очереди детерминирован
  return u;
}
const guest = async (): Promise<U> => {
  const g = (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json() as U;
  await call(g, 'GET', '/wallet');
  return g;
};
/** Убрать столы прошлых тестов (их токены уже истекли — часы сдвигаются на час). */
async function clearTables() {
  for (const d of live.splice(0)) {
    await rounds.endDealerSessions(d.userId);
    await db
      .updateTable('dealer_profile')
      .set({ status: 'offline' })
      .where('user_id', '=', d.userId)
      .execute();
  }
  await db
    .updateTable('match_ticket')
    .set({ status: 'cancelled' })
    .where('status', 'in', ['waiting', 'offered'])
    .execute();
}
const request = (p: U, body: object) => call(p, 'POST', '/matches', { stake: '1000', ...body });
const active = async (u: U) =>
  (await call(u, 'GET', '/matches/active')).body as { matches: unknown[]; shifts: unknown[] };
const sessionsOf = async (u: U) =>
  (await call(u, 'GET', '/sessions/active')).body.sessions as {
    dealerId: string;
    stake: string;
    id: string;
  }[];

/** Сессия до конца по времени → открывается смена. */
async function endByTime(p: U) {
  const s = (await sessionsOf(p))[0]!;
  now = new Date(now.getTime() + (config.game.sessionDurationSec + 1) * 1000);
  await rounds.sweep();
  const shifts = (await active(p)).shifts.map(sv);
  expect(shifts).toHaveLength(1);
  expect(shifts[0]).toMatchObject({ sessionId: s.id, status: 'open', seat: 0 });
  return shifts[0]!;
}

describe('матч', () => {
  beforeEach(clearTables);

  it('прямая заявка: крупье принимает вручную → сессия', async () => {
    const [d, p] = [await dealer(false), await guest()];
    const m = mv((await request(p, { dealerId: d.userId })).body);
    expect(m).toMatchObject({ mode: 'direct', status: 'offered', dealerId: d.userId });
    expect(Date.parse(m.offerDeadline!) - now.getTime()).toBe(config.game.matchAcceptSec * 1000);
    expect((await active(d)).matches.map(mv)[0]?.id).toBe(m.id);
    expect((await request(p, { dealerId: d.userId })).body.error).toBe('match_in_progress');
    const acc = mv((await call(d, 'POST', `/matches/${m.id}/accept`)).body);
    expect(acc.status).toBe('accepted');
    expect((await sessionsOf(p))[0]).toMatchObject({ id: acc.sessionId, dealerId: d.userId });
  });

  it('автопринятие — сессия сразу; занятой крупье и не в эфире — отказ', async () => {
    const [d, p, p2] = [await dealer(true), await guest(), await guest()];
    expect(mv((await request(p, { dealerId: d.userId })).body).status).toBe('accepted');
    expect((await request(p2, { dealerId: d.userId })).body.error).toBe('dealer_busy');
    await call(d, 'POST', '/dealer/offline');
    expect((await request(p2, { dealerId: d.userId })).status).toBe(404);
  });

  it('прямая: отказ и таймаут крупье отменяют заявку', async () => {
    const [d, p] = [await dealer(false), await guest()];
    const a = mv((await request(p, { dealerId: d.userId })).body);
    expect(mv((await call(d, 'POST', `/matches/${a.id}/decline`)).body)).toMatchObject({
      status: 'cancelled',
      reason: 'dealer_declined',
    });
    const b = mv((await request(p, { dealerId: d.userId })).body);
    now = new Date(now.getTime() + (config.game.matchAcceptSec + 1) * 1000);
    await mm.sweep();
    expect(mv((await call(p, 'GET', `/matches/${b.id}`)).body)).toMatchObject({
      status: 'cancelled',
      reason: 'dealer_timeout',
    });
  });

  it('случайный: отказ первой — предложение следующей; принятие → сессия', async () => {
    const [d1, d2, p] = [await dealer(false), await dealer(false), await guest()];
    const m = mv((await request(p, {})).body);
    expect(m).toMatchObject({ mode: 'random', status: 'offered', dealerId: d1.userId });
    const next = mv((await call(d1, 'POST', `/matches/${m.id}/decline`)).body);
    expect(next).toMatchObject({ status: 'offered', dealerId: d2.userId });
    expect(mv((await call(d2, 'POST', `/matches/${m.id}/accept`)).body).status).toBe('accepted');
    expect((await sessionsOf(p))[0]?.dealerId).toBe(d2.userId);
  });

  it('случайный: недавняя соперница — в последнюю очередь; нет столов — ожидание и истечение', async () => {
    const [d1, d2, p] = [await dealer(true), await dealer(true), await guest()];
    const first = mv((await request(p, { dealerId: d1.userId })).body);
    await call(p, 'POST', `/sessions/${first.sessionId}/leave`);
    expect(mv((await request(p, {})).body).dealerId).toBe(d2.userId);
    await clearTables();

    const p2 = await guest();
    const w = mv((await request(p2, {})).body);
    expect(w.status).toBe('waiting');
    const d3 = await dealer(true); // появилась свободная крупье — подбор на фоне
    await mm.sweep();
    expect(mv((await call(p2, 'GET', `/matches/${w.id}`)).body)).toMatchObject({
      status: 'accepted',
      dealerId: d3.userId,
    });

    await clearTables();
    const p3 = await guest();
    const e = mv((await request(p3, {})).body);
    now = new Date(now.getTime() + 61_000);
    await mm.sweep();
    expect(mv((await call(p3, 'GET', `/matches/${e.id}`)).body)).toMatchObject({
      status: 'expired',
      reason: 'no_tables',
    });
  });

  it('противоположный пол: нужен пол из KYC; девушке крупье-девушку не подберёт', async () => {
    await dealer(true);
    const g = await guest();
    expect((await request(g, { genderPref: 'opposite' })).body.error).toBe('gender_unverified');
    const man = await registered('male');
    await call(man, 'GET', '/wallet');
    expect(mv((await request(man, { genderPref: 'opposite' })).body).status).toBe('accepted');
    await dealer(true);
    const woman = await registered('female');
    await call(woman, 'GET', '/wallet');
    expect(mv((await request(woman, { genderPref: 'opposite' })).body).status).toBe('waiting');
  });

  it('лента: свободные/занятые, минимальная ставка, недавние', async () => {
    const [d1, d2, p] = [await dealer(true), await dealer(true), await guest()];
    await request(p, { dealerId: d1.userId });
    const all = feedResponseSchema.parse((await call(p, 'GET', '/feed')).body).cards;
    expect(all.find((c) => c.id === d1.userId)).toMatchObject({ busy: true, recent: true });
    expect(all.find((c) => c.id === d2.userId)).toMatchObject({ busy: false, recent: false });
    const free = feedResponseSchema.parse((await call(p, 'GET', '/feed?free=true')).body).cards;
    expect(free.map((c) => c.id)).toEqual([d2.userId]);
    expect(feedResponseSchema.parse((await call(p, 'GET', '/feed?stake=100')).body).cards).toEqual(
      [],
    );
  });
});

describe('смена', () => {
  beforeEach(clearTables);

  it('оба «остаться» — новая сессия с ×2 и серией +1', async () => {
    const [d, p] = [await dealer(true), await guest()];
    await request(p, { dealerId: d.userId });
    const sh = await endByTime(p);
    expect(sh).toMatchObject({ stake: 1000n, stayStake: 2000n, canStay: true, stayStreak: 0 });
    expect(
      sv((await call(p, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' })).body),
    ).toMatchObject({ status: 'open', myChoice: 'stay' });
    const done = sv((await call(d, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' })).body);
    expect(done).toMatchObject({ status: 'resolved', outcome: 'stay' });
    const s = (await sessionsOf(p))[0]!;
    expect(s).toMatchObject({ id: done.nextSessionId, dealerId: d.userId, stake: '2000' });
  });

  it('серия «остаться» ограничена maxStayStreak', async () => {
    const [d, p] = [await dealer(true), await guest()];
    // Ставка 100 сотых: удвоения 200/400/800 — денег хватит.
    await call(p, 'POST', '/matches', { dealerId: d.userId, stake: '500' });
    for (let i = 0; i < config.game.maxStayStreak; i++) {
      const sh = await endByTime(p);
      await call(p, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' });
      expect(
        sv((await call(d, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' })).body).outcome,
      ).toBe('stay');
    }
    const last = await endByTime(p);
    expect(last).toMatchObject({ canStay: false, stayStreak: config.game.maxStayStreak });
    expect(
      (await call(p, 'POST', `/shifts/${last.id}/decide`, { choice: 'stay' })).body.error,
    ).toBe('stay_unavailable');
  });

  it('«дальше» — подбор без этой крупье; остался один игрок — тоже «дальше»', async () => {
    const [d1, d2, p] = [await dealer(true), await dealer(true), await guest()];
    await request(p, { dealerId: d1.userId });
    let sh = await endByTime(p);
    expect(
      sv((await call(p, 'POST', `/shifts/${sh.id}/decide`, { choice: 'next' })).body),
    ).toMatchObject({ status: 'resolved', outcome: 'next' });
    expect((await sessionsOf(p))[0]?.dealerId).toBe(d2.userId);

    sh = await endByTime(p);
    await call(p, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' });
    expect(
      sv((await call(d2, 'POST', `/shifts/${sh.id}/decide`, { choice: 'next' })).body).outcome,
    ).toBe('next');
    expect((await sessionsOf(p))[0]?.dealerId).toBe(d1.userId);
  });

  it('молчание до дедлайна — выход в ленту; пауза при пополнении продлевает один раз', async () => {
    const [d, p] = [await dealer(true), await guest()];
    await request(p, { dealerId: d.userId });
    const sh = await endByTime(p);
    const paused = sv((await call(p, 'POST', `/shifts/${sh.id}/pause`)).body);
    expect(Date.parse(paused.deadline) - Date.parse(sh.deadline)).toBe(
      config.game.inlineDepositPauseSec * 1000,
    );
    expect(sv((await call(p, 'POST', `/shifts/${sh.id}/pause`)).body).deadline).toBe(
      paused.deadline,
    );
    now = new Date(Date.parse(sh.deadline) + 1000);
    await mm.sweep();
    expect((await active(p)).shifts).toHaveLength(1); // ещё на паузе
    now = new Date(Date.parse(paused.deadline) + 1000);
    await mm.sweep();
    expect((await active(p)).shifts).toHaveLength(0);
    expect(await sessionsOf(p)).toEqual([]);
  });

  it('крупье не может выбрать «противоположный пол»; повторное решение — отказ', async () => {
    const [d, p] = [await dealer(true), await guest()];
    await request(p, { dealerId: d.userId });
    const sh = await endByTime(p);
    expect(
      (await call(d, 'POST', `/shifts/${sh.id}/decide`, { choice: 'opposite' })).body.error,
    ).toBe('invalid_choice');
    await call(d, 'POST', `/shifts/${sh.id}/decide`, { choice: 'stay' });
    expect((await call(d, 'POST', `/shifts/${sh.id}/decide`, { choice: 'next' })).body.error).toBe(
      'already_decided',
    );
  });
});
