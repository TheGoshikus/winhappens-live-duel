import type { CoreConfig } from '@winhappens/config';
import { geoPolicyFromEnv } from '@winhappens/config';
import type { Db } from './db/index.js';
import { createEligibility } from './eligibility/index.js';
import { MockKycProvider } from './identity/kyc.js';
import { MockOtpSender, type OtpSender } from './identity/otp.js';
import type { IdentityRoutesDeps } from './identity/routes.js';
import { createIdentityService } from './identity/service.js';
import { createTokens } from './identity/tokens.js';
import { createGatewayClient } from './payments/gateway-client.js';
import type { PaymentRoutesDeps } from './payments/routes.js';
import { createPaymentsService } from './payments/service.js';
import type { RoundRoutesDeps } from './rounds/routes.js';
import { createRoundService, type Changes, type RoundService } from './rounds/service.js';
import { createRoundSigner } from './rounds/signer.js';
import { createLiveKit } from './video/livekit.js';
import type { VideoRoutesDeps } from './video/routes.js';
import { createVideoService, type VideoDeps } from './video/service.js';
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
      stakeFeeBps: config.game.stakeFeeBps,
      winFeeBps: config.game.winFeeBps,
      reciprocityWinFeeBps: config.game.reciprocityWinFeeBps,
    }),
    devRoutes: config.env.NODE_ENV !== 'production',
  };
}

export function createVideoModule(
  db: Db,
  config: CoreConfig,
  identity: IdentityRoutesDeps,
  hooks: Pick<VideoDeps, 'busy' | 'onOffline' | 'onTablesChanged'> = {},
): VideoRoutesDeps {
  const { env } = config;
  const livekit = createLiveKit({
    publicUrl: env.LIVEKIT_PUBLIC_URL ?? env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
  });
  const video = createVideoService({
    db,
    livekit,
    eligibility: identity.eligibility,
    // Для допуска крупье гео не нужно — страна по IP здесь не участвует.
    subject: (userId) => identity.identity.getSubject(userId, null),
    ...hooks,
  });
  return { video, livekit };
}

export function createRoundModule(
  db: Db,
  config: CoreConfig,
  identity: IdentityRoutesDeps,
  wallet: WalletRoutesDeps,
  opts: {
    clock?: () => Date;
    isOnline?: (userId: string) => Promise<boolean>;
    emit?: (changes: Changes, svc: RoundService) => Promise<void>;
  } = {},
): RoundRoutesDeps {
  return {
    rounds: createRoundService({
      db,
      wallet: wallet.wallet,
      eligibility: identity.eligibility,
      subject: (userId, ip) => identity.identity.getSubject(userId, ip),
      signer: createRoundSigner(config.env.ROUND_SIGNING_KEY),
      game: config.game,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.isOnline ? { isOnline: opts.isOnline } : {}),
      ...(opts.emit ? { emit: opts.emit } : {}),
    }),
    countryHeader: config.env.GEO_COUNTRY_HEADER,
  };
}

export function createPaymentsModule(
  config: CoreConfig,
  identity: IdentityRoutesDeps,
  wallet: WalletRoutesDeps,
  fetchImpl?: typeof fetch,
  onWallet?: (userId: string) => Promise<void>,
): PaymentRoutesDeps {
  const { env } = config;
  return {
    payments: createPaymentsService({
      gateway: createGatewayClient(env.PAYMENT_GATEWAY_URL, env.PAYMENT_GATEWAY_SECRET, fetchImpl),
      wallet: wallet.wallet,
      eligibility: identity.eligibility,
      subject: (userId, ip) => identity.identity.getSubject(userId, ip),
      ...(onWallet ? { onWallet } : {}),
    }),
    gatewaySecret: env.PAYMENT_GATEWAY_SECRET,
    countryHeader: env.GEO_COUNTRY_HEADER,
  };
}
