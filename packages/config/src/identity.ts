import { z } from 'zod';

/** "true"/"false"/"1"/"0" → boolean. z.coerce.boolean() считает "false" истиной. */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
/** "RU, us,de" → ['RU','US','DE'] (ISO 3166-1 alpha-2). */
const countries = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[A-Z]{2}$/, 'expected ISO 3166-1 alpha-2 codes')));
const sec = (def: number) => z.coerce.number().int().positive().default(def);

export const identityEnvSchema = z.object({
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SEC: sec(15 * 60),
  REFRESH_TOKEN_TTL_SEC: sec(30 * 24 * 3600),
  OTP_TTL_SEC: sec(5 * 60),
  OTP_MAX_ATTEMPTS: sec(5),
  /** Сколько OTP можно запросить на один адрес за час. */
  OTP_MAX_PER_HOUR: sec(5),
  /** Заголовок со страной клиента от доверенного прокси/CDN (например, cf-ipcountry). */
  GEO_COUNTRY_HEADER: z.string().toLowerCase().default('cf-ipcountry'),
  /** Страны, где запрещена игра на реальные деньги. */
  GEO_REAL_MONEY_BLOCKED: countries.default(''),
  /** Страны, где разрешён модуль 18+. Пусто — 18+ выключен везде (roadmap, этап 10). */
  GEO_ADULT_ALLOWED: countries.default(''),
  /** Блокировать реальные деньги, если IP-страна ≠ KYC-страна (docs/decisions.md). */
  GEO_REQUIRE_MATCH: bool.default('true'),
  KYC_REQUIRED_FOR_REAL_PLAY: bool.default('true'),
  MIN_AGE: z.coerce.number().int().min(18).max(25).default(18),
});

export type IdentityEnv = z.infer<typeof identityEnvSchema>;

export interface GeoPolicy {
  realMoneyBlocked: ReadonlySet<string>;
  adultAllowed: ReadonlySet<string>;
  requireMatch: boolean;
  kycRequiredForRealPlay: boolean;
  minAge: number;
}

export function geoPolicyFromEnv(env: IdentityEnv): GeoPolicy {
  return {
    realMoneyBlocked: new Set(env.GEO_REAL_MONEY_BLOCKED),
    adultAllowed: new Set(env.GEO_ADULT_ALLOWED),
    requireMatch: env.GEO_REQUIRE_MATCH,
    kycRequiredForRealPlay: env.KYC_REQUIRED_FOR_REAL_PLAY,
    minAge: env.MIN_AGE,
  };
}
