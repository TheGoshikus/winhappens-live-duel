import type { GameConfig, GeoPolicy } from '@winhappens/config';
import type { Currency, Minor } from '@winhappens/shared';
import type { Gender, KycStatus, UserKind, UserStatus } from '../db/schema.js';

/**
 * Допуск (architecture §0). Чистые функции над снимком пользователя: остальные модули спрашивают
 * только can*. Гость играет на FUN; USDT и 18+ — после регистрации и KYC (docs/decisions.md).
 */
export interface EligibilitySubject {
  user: { kind: UserKind; status: UserStatus };
  kyc: {
    status: KycStatus;
    birthdate: string | null;
    verifiedGender: Gender | null;
    country: string | null;
  } | null;
  settings: { adultOptIn: boolean; selfExcludedUntil: Date | null } | null;
  /** Страна по IP текущего запроса/соединения. */
  ipCountry: string | null;
}

export type DenyReason =
  | 'user_blocked'
  | 'stake_out_of_range'
  | 'registration_required'
  | 'self_excluded'
  | 'kyc_required'
  | 'underage'
  | 'geo_unknown'
  | 'geo_blocked'
  | 'geo_mismatch'
  | 'adult_unavailable'
  | 'adult_opt_in_required'
  | 'stay_streak_exceeded'
  | 'gender_unverified'
  | 'dealer_female_only';

export type Decision = { ok: true } | { ok: false; reason: DenyReason };

const ALLOW: Decision = { ok: true };
const deny = (reason: DenyReason): Decision => ({ ok: false, reason });

export type EligibilityRules = Pick<
  GameConfig,
  | 'minStakeUsdt'
  | 'maxStakeUsdt'
  | 'minStakeFun'
  | 'maxStakeFun'
  | 'maxStayStreak'
  | 'stayStakeMultiplier'
>;

/** Полных лет на дату now (UTC). birthdate — YYYY-MM-DD. */
export function ageOn(birthdate: string, now: Date): number {
  const [y, m, d] = birthdate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  const beforeBirthday =
    now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export function createEligibility(
  rules: EligibilityRules,
  geo: GeoPolicy,
  clock: () => Date = () => new Date(),
) {
  const verifiedAdult = (s: EligibilitySubject): Decision => {
    if (s.kyc?.status !== 'verified' || !s.kyc.birthdate) return deny('kyc_required');
    if (ageOn(s.kyc.birthdate, clock()) < geo.minAge) return deny('underage');
    return ALLOW;
  };

  /** Обе страны (IP и KYC) должны проходить allowed(); при расхождении — geo_mismatch. */
  const checkGeo = (
    s: EligibilitySubject,
    allowed: (country: string) => boolean,
    blocked: DenyReason,
  ): Decision => {
    if (!s.ipCountry) return deny('geo_unknown');
    if (!allowed(s.ipCountry)) return deny(blocked);
    const kycCountry = s.kyc?.status === 'verified' ? s.kyc.country : null;
    if (kycCountry) {
      if (!allowed(kycCountry)) return deny(blocked);
      if (geo.requireMatch && kycCountry !== s.ipCountry) return deny('geo_mismatch');
    }
    return ALLOW;
  };

  const stakeInRange = (currency: Currency, stake: Minor): boolean =>
    currency === 'USDT'
      ? stake >= rules.minStakeUsdt && stake <= rules.maxStakeUsdt
      : stake >= rules.minStakeFun && stake <= rules.maxStakeFun;

  function canPlay(s: EligibilitySubject, q: { currency: Currency; stake: Minor }): Decision {
    if (s.user.status !== 'active') return deny('user_blocked');
    if (!stakeInRange(q.currency, q.stake)) return deny('stake_out_of_range');
    if (q.currency === 'FUN') return ALLOW;

    if (s.user.kind !== 'registered') return deny('registration_required');
    const until = s.settings?.selfExcludedUntil;
    if (until && until > clock()) return deny('self_excluded');
    if (geo.kycRequiredForRealPlay) {
      const adult = verifiedAdult(s);
      if (!adult.ok) return adult;
    }
    return checkGeo(s, (c) => !geo.realMoneyBlocked.has(c), 'geo_blocked');
  }

  /** Личный допуск к 18+. Для пары нужен canAdult обоих (оба opt-in). */
  function canAdult(s: EligibilitySubject): Decision {
    if (s.user.status !== 'active') return deny('user_blocked');
    const adult = verifiedAdult(s);
    if (!adult.ok) return adult;
    const g = checkGeo(s, (c) => geo.adultAllowed.has(c), 'adult_unavailable');
    if (!g.ok) return g;
    if (!s.settings?.adultOptIn) return deny('adult_opt_in_required');
    return ALLOW;
  }

  /** «Остаться ×2» на экране Shift: лимит серии и допуск к удвоенной ставке. */
  function canStayX2(
    s: EligibilitySubject,
    q: { currency: Currency; stake: Minor; stayStreak: number },
  ): Decision {
    if (q.stayStreak >= rules.maxStayStreak) return deny('stay_streak_exceeded');
    return canPlay(s, { currency: q.currency, stake: q.stake * BigInt(rules.stayStakeMultiplier) });
  }

  /** «Противоположный пол»: пол берётся только из KYC (architecture §3). */
  function canOpposite(s: EligibilitySubject): Decision {
    if (s.user.status !== 'active') return deny('user_blocked');
    if (s.kyc?.status !== 'verified' || !s.kyc.verifiedGender) return deny('gender_unverified');
    return ALLOW;
  }

  /**
   * Стол крупье может открыть только девушка: подтверждённый KYC, пол из KYC, совершеннолетие
   * (docs/decisions.md). Договор и согласие на формат — на стороне площадки.
   */
  function canBeDealer(s: EligibilitySubject): Decision {
    if (s.user.status !== 'active') return deny('user_blocked');
    if (s.user.kind !== 'registered') return deny('registration_required');
    const adult = verifiedAdult(s);
    if (!adult.ok) return adult;
    if (s.kyc?.verifiedGender !== 'female') return deny('dealer_female_only');
    return ALLOW;
  }

  return { canPlay, canAdult, canStayX2, canOpposite, canBeDealer };
}

export type Eligibility = ReturnType<typeof createEligibility>;
