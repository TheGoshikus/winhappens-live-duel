import type { CoreConfig } from '@winhappens/config';
import { geoPolicyFromEnv } from '@winhappens/config';
import type { Db } from './db/index.js';
import { createEligibility } from './eligibility/index.js';
import { MockKycProvider } from './identity/kyc.js';
import { MockOtpSender, type OtpSender } from './identity/otp.js';
import type { IdentityRoutesDeps } from './identity/routes.js';
import { createIdentityService } from './identity/service.js';
import { createTokens } from './identity/tokens.js';
import type { WalletRoutesDeps } from './wallet/routes.js';
import { createWalletService } from './wallet/service.js';

/** Собирает модуль identity из конфига. Провайдеры OTP/KYC пока mock (этап 1). */
export function createIdentityModule(
  db: Db,
  config: CoreConfig,
  opts: { otp?: OtpSender; clock?: () => Date; log?: (msg: string) => void } = {},
): IdentityRoutesDeps {
  const { env, game } = config;
  const clock = opts.clock ?? (() => new Date());
  const tokens = createTokens(
    {
      secret: env.JWT_SECRET,
      accessTtlSec: env.ACCESS_TOKEN_TTL_SEC,
      refreshTtlSec: env.REFRESH_TOKEN_TTL_SEC,
    },
    clock,
  );
  const identity = createIdentityService({
    db,
    tokens,
    otp: opts.otp ?? new MockOtpSender(opts.log),
    kyc: new MockKycProvider(),
    settings: {
      otpSecret: env.JWT_SECRET,
      otpTtlSec: env.OTP_TTL_SEC,
      otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
      otpMaxPerHour: env.OTP_MAX_PER_HOUR,
    },
    clock,
  });
  return {
    identity,
    tokens,
    eligibility: createEligibility(game, geoPolicyFromEnv(env), clock),
    game,
    countryHeader: env.GEO_COUNTRY_HEADER,
    devRoutes: env.NODE_ENV !== 'production',
  };
}

export function createWalletModule(db: Db, config: CoreConfig): WalletRoutesDeps {
  return {
    wallet: createWalletService(db, {
      funStartingBalance: config.game.funStartingBalance,
      rakeBps: config.game.rakeBps,
    }),
    devRoutes: config.env.NODE_ENV !== 'production',
  };
}
