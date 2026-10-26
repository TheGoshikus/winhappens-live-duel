import { loadCoreConfig } from '@winhappens/config';
import { liveDealersResponseSchema, roomAccessSchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MockOtpSender } from '../identity/otp.js';
import { testEnv } from '../test/env.js';
import { startTestDb } from '../test/postgres.js';
import { createIdentityModule, createVideoModule } from '../wiring.js';

const config = loadCoreConfig(testEnv);
const { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET } = config.env;
let app: FastifyInstance;
let stop: () => Promise<void>;
const otp = new MockOtpSender();

beforeAll(async () => {
  const t = await startTestDb();
  stop = t.stop;
  const identity = createIdentityModule(t.db, config, { otp });
  app = buildApp({ probes: {}, identity, video: createVideoModule(t.db, config, identity) });
});
afterAll(async () => {
  await app?.close();
  await stop?.();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let seq = 0;

async function guest() {
  return (await app.inject({ method: 'POST', url: '/auth/guest', payload: {} })).json() as {
    userId: string;
    accessToken: string;
  };
}

/** Зарегистрированный пользователь с пройденным KYC указанного пола. */
async function verified(gender: 'female' | 'male') {
  const destination = `dealer${++seq}@example.com`;
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
  ).json() as { userId: string; accessToken: string };
  await app.inject({ method: 'POST', url: '/kyc/start', headers: auth(u.accessToken) });
  await app.inject({
    method: 'POST',
    url: '/dev/kyc/complete',
    headers: auth(u.accessToken),
    payload: { birthdate: '1998-03-08', gender, country: 'DE' },
  });
  return u;
}

const goLive = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/dealer/live',
    headers: auth(token),
    payload: { displayName: 'Алина', scene: 'cabaret', minStake: '500' },
  });

const grants = async (jwt: string) => new TokenVerifier(KEY, SECRET).verify(jwt);

describe('крупье', () => {
  it('стол открывает только девушка с KYC', async () => {
    const g = await guest();
    expect((await goLive(g.accessToken)).json()).toMatchObject({ error: 'registration_required' });
    const m = await verified('male');
    const r = await goLive(m.accessToken);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('dealer_female_only');
  });

  it('эфир → в списке → зритель получает токен только на просмотр → уход из эфира', async () => {
    const d = await verified('female');
    const live = roomAccessSchema.parse((await goLive(d.accessToken)).json());
    expect(live.room).toBe(`dealer-${d.userId}`);
    const dg = await grants(live.token);
    expect(dg.sub).toBe(d.userId);
    expect(dg.video).toMatchObject({ room: live.room, roomJoin: true, canPublish: true });

    const viewer = await guest();
    const list = liveDealersResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/dealers', headers: auth(viewer.accessToken) })
      ).json(),
    );
    expect(list.dealers).toContainEqual({
      id: d.userId,
      name: 'Алина',
      scene: 'cabaret',
      currency: 'FUN',
      minStake: 500n,
      room: live.room,
      busy: false,
    });

    const watch = roomAccessSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/dealers/${d.userId}/watch`,
          headers: auth(viewer.accessToken),
        })
      ).json(),
    );
    const vg = await grants(watch.token);
    expect(vg.sub).toBe(viewer.userId);
    expect(vg.video).toMatchObject({
      room: live.room,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/dealers/${d.userId}/watch`,
          headers: auth(d.accessToken),
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (await app.inject({ method: 'POST', url: '/dealer/offline', headers: auth(d.accessToken) }))
        .statusCode,
    ).toBe(204);
    const after = await app.inject({
      method: 'POST',
      url: `/dealers/${d.userId}/watch`,
      headers: auth(viewer.accessToken),
    });
    expect(after.statusCode).toBe(404);
  });

  it('вебхук LiveKit: без подписи — 401; крупье вышла из комнаты — стол уходит из эфира', async () => {
    const d = await verified('female');
    await goLive(d.accessToken);
    const body = JSON.stringify({
      event: 'participant_left',
      room: { name: `dealer-${d.userId}` },
      participant: { identity: d.userId },
    });
    const send = (authorization?: string) =>
      app.inject({
        method: 'POST',
        url: '/livekit/webhook',
        headers: {
          'content-type': 'application/webhook+json',
          ...(authorization ? { authorization } : {}),
        },
        payload: body,
      });
    expect((await send()).statusCode).toBe(401);

    const at = new AccessToken(KEY, SECRET);
    at.sha256 = createHash('sha256').update(body).digest('base64');
    expect((await send(await at.toJwt())).statusCode).toBe(204);

    const viewer = await guest();
    const list = liveDealersResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/dealers', headers: auth(viewer.accessToken) })
      ).json(),
    );
    expect(list.dealers.map((x) => x.id)).not.toContain(d.userId);
  });
});
