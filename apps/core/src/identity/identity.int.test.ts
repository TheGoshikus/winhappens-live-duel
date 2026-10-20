import { loadCoreConfig } from '@winhappens/config';
import { otpVerifyResponseSchema, tokenPairSchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Db } from '../db/index.js';
import { startTestDb } from '../test/postgres.js';
import { createIdentityModule } from '../wiring.js';
import { MockOtpSender } from './otp.js';

const env = {
  NODE_ENV: 'test',
  CORE_DATABASE_URL: 'postgres://unused@localhost/core',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  PAYMENT_GATEWAY_URL: 'http://localhost:3100',
  JWT_SECRET: 'test-secret-test-secret-test-secret!',
  GEO_REAL_MONEY_BLOCKED: 'US',
  GEO_ADULT_ALLOWED: 'DE',
  OTP_MAX_ATTEMPTS: '3',
  OTP_MAX_PER_HOUR: '3',
};

let db: Db;
let stop: () => Promise<void>;
let app: FastifyInstance;
let otp: MockOtpSender;
let now: Date;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});
beforeEach(async () => {
  await app?.close();
  now = new Date('2026-10-20T12:00:00Z');
  otp = new MockOtpSender();
  app = buildApp({
    probes: {},
    identity: createIdentityModule(db, loadCoreConfig(env), { otp, clock: () => now }),
  });
});

const DE = { 'cf-ipcountry': 'DE' };
const auth = (token: string, headers: Record<string, string> = DE) => ({
  ...headers,
  authorization: `Bearer ${token}`,
});
let seq = 0;
const freshEmail = () => `player${++seq}@example.com`;

async function guest(deviceId?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/guest',
    headers: DE,
    payload: deviceId ? { deviceId } : {},
  });
  expect(res.statusCode).toBe(201);
  return tokenPairSchema.parse(res.json());
}

async function otpLogin(destination: string, token?: string) {
  const headers = token ? auth(token) : DE;
  const start = await app.inject({
    method: 'POST',
    url: '/auth/otp/start',
    headers,
    payload: { channel: 'email', destination },
  });
  expect(start.statusCode).toBe(202);
  const { challengeId } = start.json();
  const code = otp.lastCodeFor(destination.trim().toLowerCase())!;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    headers,
    payload: { challengeId, code },
  });
  expect(res.statusCode).toBe(200);
  return otpVerifyResponseSchema.parse(res.json());
}

const me = async (token: string, headers?: Record<string, string>) =>
  (await app.inject({ method: 'GET', url: '/me', headers: auth(token, headers) })).json();

describe('гость', () => {
  it('создаётся без регистрации и играет только на FUN', async () => {
    const g = await guest('device-abcdef12');
    const profile = await me(g.accessToken);
    expect(profile).toMatchObject({ id: g.userId, kind: 'guest', ipCountry: 'DE', contacts: [] });
    expect(profile.eligibility.playFun).toEqual({ ok: true });
    expect(profile.eligibility.playUsdt).toEqual({ ok: false, reason: 'registration_required' });
    const links = await db
      .selectFrom('device_link')
      .selectAll()
      .where('user_id', '=', g.userId)
      .execute();
    expect(links).toHaveLength(1);
    expect(links[0]!.fingerprint).not.toBe('device-abcdef12');
  });

  it('/me без токена — 401, с битым токеном — 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer junk' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('OTP', () => {
  it('гость становится registered с тем же user_id; вход с другого устройства — в тот же аккаунт', async () => {
    const g = await guest();
    const email = freshEmail();
    const reg = await otpLogin(`  ${email.toUpperCase()} `, g.accessToken);
    expect(reg).toMatchObject({ userId: g.userId, outcome: 'registered' });
    expect(await me(reg.accessToken)).toMatchObject({
      kind: 'registered',
      contacts: [{ kind: 'email', value: email }],
    });

    const other = await otpLogin(email);
    expect(other).toMatchObject({ userId: g.userId, outcome: 'login' });

    // Гость на новом устройстве вводит тот же контакт — это вход, а не захват контакта.
    const g2 = await guest();
    expect(await otpLogin(email, g2.accessToken)).toMatchObject({
      userId: g.userId,
      outcome: 'login',
    });
    expect((await me(g2.accessToken)).kind).toBe('guest');
  });

  it('без авторизации и с новым контактом создаёт аккаунт; registered добавляет второй контакт', async () => {
    const created = await otpLogin(freshEmail());
    expect(created.outcome).toBe('created');
    expect(await otpLogin(freshEmail(), created.accessToken)).toMatchObject({
      userId: created.userId,
      outcome: 'linked',
    });
    expect((await me(created.accessToken)).contacts).toHaveLength(2);
  });

  it('неверный код: попытки ограничены, затем 429 даже для верного кода', async () => {
    const email = freshEmail();
    const start = await app.inject({
      method: 'POST',
      url: '/auth/otp/start',
      payload: { channel: 'email', destination: email },
    });
    const { challengeId } = start.json();
    const code = otp.lastCodeFor(email)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/otp/verify',
        payload: { challengeId, code: wrong },
      });
      expect(r.json()).toMatchObject({ error: 'otp_invalid' });
    }
    const r = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { challengeId, code },
    });
    expect(r.statusCode).toBe(429);
  });

  it('код одноразовый, истекает и привязан к тому, кто его запросил', async () => {
    const email = freshEmail();
    const g = await guest();
    const start = await app.inject({
      method: 'POST',
      url: '/auth/otp/start',
      headers: auth(g.accessToken),
      payload: { channel: 'email', destination: email },
    });
    const { challengeId } = start.json();
    const code = otp.lastCodeFor(email)!;
    // Чужой (анонимный) запрос с перехваченным кодом не проходит.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/otp/verify',
          payload: { challengeId, code },
        })
      ).statusCode,
    ).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      headers: auth(g.accessToken),
      payload: { challengeId, code },
    });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      headers: auth(g.accessToken),
      payload: { challengeId, code },
    });
    expect(again.statusCode).toBe(400);

    const email2 = freshEmail();
    const s2 = (
      await app.inject({
        method: 'POST',
        url: '/auth/otp/start',
        payload: { channel: 'email', destination: email2 },
      })
    ).json();
    now = new Date(now.getTime() + 301_000);
    const late = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { challengeId: s2.challengeId, code: otp.lastCodeFor(email2) },
    });
    expect(late.json()).toMatchObject({ error: 'otp_invalid' });
  });

  it('лимит запросов кода на адрес в час', async () => {
    const payload = { channel: 'phone', destination: '+7 (999) 123-45-67' };
    for (let i = 0; i < 3; i++) {
      expect(
        (await app.inject({ method: 'POST', url: '/auth/otp/start', payload })).statusCode,
      ).toBe(202);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/otp/start', payload })).statusCode).toBe(
      429,
    );
    expect(otp.sent.at(-1)?.destination).toBe('+79991234567');
    now = new Date(now.getTime() + 3601_000);
    expect((await app.inject({ method: 'POST', url: '/auth/otp/start', payload })).statusCode).toBe(
      202,
    );
  });

  it('валидирует адрес', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/otp/start',
      payload: { channel: 'phone', destination: '12345' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('validation_failed');
  });
});

describe('refresh', () => {
  it('ротирует токен; повторное использование старого отзывает всю семью', async () => {
    const g = await guest();
    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: g.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const p1 = tokenPairSchema.parse(r1.json());
    expect(p1.refreshToken).not.toBe(g.refreshToken);

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: g.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    const afterTheft = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: p1.refreshToken },
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('logout отзывает refresh; истёкший refresh не принимается', async () => {
    const g = await guest();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout',
          payload: { refreshToken: g.refreshToken },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refreshToken: g.refreshToken },
        })
      ).statusCode,
    ).toBe(401);

    const g2 = await guest();
    now = new Date(now.getTime() + 31 * 86_400_000);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refreshToken: g2.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('access-токен истекает', async () => {
    const g = await guest();
    now = new Date(now.getTime() + 16 * 60_000);
    expect(
      (await app.inject({ method: 'GET', url: '/me', headers: auth(g.accessToken) })).statusCode,
    ).toBe(401);
  });
});

describe('KYC и допуск', () => {
  const kycDone = (token: string, body: object) =>
    app.inject({
      method: 'POST',
      url: '/dev/kyc/complete',
      headers: auth(token),
      payload: { birthdate: '1990-05-01', gender: 'female', country: 'DE', ...body },
    });

  it('гость не может пройти KYC', async () => {
    const g = await guest();
    const r = await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(g.accessToken) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('registration_required');
  });

  it('после KYC открываются USDT и «противоположный пол»; 18+ — после opt-in; гео по IP и KYC', async () => {
    const u = await otpLogin(freshEmail());
    expect((await me(u.accessToken)).eligibility.playUsdt).toMatchObject({
      reason: 'kyc_required',
    });
    expect((await kycDone(u.accessToken, {})).statusCode).toBe(409); // не начат

    expect(
      (await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(u.accessToken) }))
        .statusCode,
    ).toBe(201);
    expect((await kycDone(u.accessToken, {})).statusCode).toBe(204);

    const p = await me(u.accessToken);
    expect(p.kyc).toEqual({ status: 'verified', country: 'DE' });
    expect(p.eligibility).toMatchObject({
      playUsdt: { ok: true },
      opposite: { ok: true },
      adult: { ok: false, reason: 'adult_opt_in_required' },
    });

    await app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: auth(u.accessToken),
      payload: { adultOptIn: true },
    });
    expect((await me(u.accessToken)).eligibility.adult).toEqual({ ok: true });

    // Тот же аккаунт из другой страны: реальные деньги и 18+ блокируются.
    const fr = await me(u.accessToken, { 'cf-ipcountry': 'FR' });
    expect(fr.eligibility).toMatchObject({
      playUsdt: { reason: 'geo_mismatch' },
      adult: { reason: 'adult_unavailable' },
      playFun: { ok: true },
    });
    expect((await me(u.accessToken, {})).eligibility.playUsdt).toMatchObject({
      reason: 'geo_unknown',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(u.accessToken) }))
        .statusCode,
    ).toBe(409);
  });

  it('несовершеннолетний не играет на USDT', async () => {
    const u = await otpLogin(freshEmail());
    await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(u.accessToken) });
    await kycDone(u.accessToken, { birthdate: '2010-01-01' });
    expect((await me(u.accessToken)).eligibility.playUsdt).toMatchObject({ reason: 'underage' });
  });

  it('самоисключение блокирует USDT и не сокращается', async () => {
    const u = await otpLogin(freshEmail());
    await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(u.accessToken) });
    await kycDone(u.accessToken, {});
    const patch = (days: number) =>
      app.inject({
        method: 'PATCH',
        url: '/me/settings',
        headers: auth(u.accessToken),
        payload: { selfExcludeDays: days },
      });
    await patch(30);
    const first = (await me(u.accessToken)).settings.selfExcludedUntil;
    await patch(1);
    const p = await me(u.accessToken);
    expect(p.settings.selfExcludedUntil).toBe(first);
    expect(p.eligibility).toMatchObject({
      playUsdt: { reason: 'self_excluded' },
      playFun: { ok: true },
    });
  });
});
