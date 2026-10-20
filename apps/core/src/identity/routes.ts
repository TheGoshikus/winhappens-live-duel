import type { GameConfig } from '@winhappens/config';
import {
  guestRequestSchema,
  kycDevCompleteSchema,
  otpStartRequestSchema,
  otpVerifyRequestSchema,
  refreshRequestSchema,
  settingsPatchSchema,
} from '@winhappens/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Eligibility } from '../eligibility/index.js';
import { requireUser } from './auth.js';
import { countryFromRequest } from './geo.js';
import type { IdentityService } from './service.js';
import type { Tokens } from './tokens.js';

export interface IdentityRoutesDeps {
  identity: IdentityService;
  tokens: Tokens;
  eligibility: Eligibility;
  game: Pick<GameConfig, 'minStakeUsdt' | 'minStakeFun'>;
  countryHeader: string;
  /** Включает /dev/* (mock KYC). Никогда — в production. */
  devRoutes: boolean;
}

export async function identityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps) {
  const { identity, eligibility } = deps;
  const country = (req: FastifyRequest) => countryFromRequest(req, deps.countryHeader);

  app.post('/auth/guest', async (req, reply) => {
    const body = guestRequestSchema.parse(req.body ?? {});
    reply.code(201);
    return identity.createGuest({ ipCountry: country(req), deviceId: body.deviceId });
  });

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = refreshRequestSchema.parse(req.body);
    return identity.refresh(refreshToken, country(req));
  });

  app.post('/auth/logout', async (req, reply) => {
    const { refreshToken } = refreshRequestSchema.parse(req.body);
    await identity.logout(refreshToken);
    reply.code(204);
  });

  app.post('/auth/otp/start', async (req, reply) => {
    const body = otpStartRequestSchema.parse(req.body);
    reply.code(202);
    return identity.startOtp({ ...body, requestedBy: req.userId });
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = otpVerifyRequestSchema.parse(req.body);
    return identity.verifyOtp({ ...body, requestedBy: req.userId, ipCountry: country(req) });
  });

  app.get('/me', async (req) => {
    const userId = requireUser(req);
    const ip = country(req);
    const [p, subject] = await Promise.all([
      identity.getProfile(userId),
      identity.getSubject(userId, ip),
    ]);
    return {
      id: p.user.id,
      kind: p.user.kind,
      status: p.user.status,
      ipCountry: ip,
      contacts: p.contacts.map((c) => ({ kind: c.kind, value: c.value })),
      kyc: p.kyc && { status: p.kyc.status, country: p.kyc.country?.trim() ?? null },
      settings: p.settings && {
        adultOptIn: p.settings.adult_opt_in,
        selfExcludedUntil: p.settings.self_excluded_until?.toISOString() ?? null,
      },
      eligibility: {
        playFun: eligibility.canPlay(subject, { currency: 'FUN', stake: deps.game.minStakeFun }),
        playUsdt: eligibility.canPlay(subject, { currency: 'USDT', stake: deps.game.minStakeUsdt }),
        adult: eligibility.canAdult(subject),
        opposite: eligibility.canOpposite(subject),
      },
    };
  });

  app.patch('/me/settings', async (req, reply) => {
    await identity.updateSettings(requireUser(req), settingsPatchSchema.parse(req.body));
    reply.code(204);
  });

  app.post('/kyc/start', async (req, reply) => {
    reply.code(201);
    return identity.startKyc(requireUser(req));
  });

  if (deps.devRoutes) {
    app.post('/dev/kyc/complete', async (req, reply) => {
      await identity.completeKyc(requireUser(req), kycDevCompleteSchema.parse(req.body));
      reply.code(204);
    });
  }
}
