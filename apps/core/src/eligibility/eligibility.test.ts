import type { GeoPolicy } from '@winhappens/config';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  createEligibility,
  type EligibilityRules,
  type EligibilitySubject,
} from './index.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const rules: EligibilityRules = {
  minStakeUsdt: 1_000_000n,
  maxStakeUsdt: 100_000_000n,
  minStakeFun: 100n,
  maxStakeFun: 10_000n,
  maxStayStreak: 3,
  stayStakeMultiplier: 2,
};
const policy = (p: Partial<GeoPolicy> = {}): GeoPolicy => ({
  realMoneyBlocked: new Set(['US']),
  adultAllowed: new Set(['DE']),
  requireMatch: true,
  kycRequiredForRealPlay: true,
  minAge: 18,
  ...p,
});
const elig = (p?: Partial<GeoPolicy>) => createEligibility(rules, policy(p), () => NOW);

const guest: EligibilitySubject = {
  user: { kind: 'guest', status: 'active' },
  kyc: null,
  settings: null,
  ipCountry: 'DE',
};
const verified: EligibilitySubject = {
  user: { kind: 'registered', status: 'active' },
  kyc: { status: 'verified', birthdate: '1990-05-01', verifiedGender: 'female', country: 'DE' },
  settings: { adultOptIn: true, selfExcludedUntil: null },
  ipCountry: 'DE',
};
const withKyc = (kyc: Partial<NonNullable<EligibilitySubject['kyc']>>): EligibilitySubject => ({
  ...verified,
  kyc: { ...verified.kyc!, ...kyc },
});

const USDT = (n: number) => ({ currency: 'USDT' as const, stake: BigInt(n) * 1_000_000n });
const FUN = (n: bigint) => ({ currency: 'FUN' as const, stake: n });

describe('ageOn', () => {
  it('считает полные годы с учётом дня рождения', () => {
    expect(ageOn('2008-10-20', NOW)).toBe(18);
    expect(ageOn('2008-10-21', NOW)).toBe(17);
    expect(ageOn('2008-11-01', NOW)).toBe(17);
    expect(ageOn('2000-02-29', new Date('2026-02-28T00:00:00Z'))).toBe(25);
  });
});

describe('canPlay', () => {
  it('гость играет на FUN без регистрации, даже без страны', () => {
    expect(elig().canPlay(guest, FUN(100n))).toEqual({ ok: true });
    expect(elig().canPlay({ ...guest, ipCountry: null }, FUN(100n))).toEqual({ ok: true });
  });

  it('гость не играет на USDT', () => {
    expect(elig().canPlay(guest, USDT(1))).toEqual({ ok: false, reason: 'registration_required' });
  });

  it('проверяет диапазон ставки по валюте', () => {
    expect(elig().canPlay(guest, FUN(99n))).toMatchObject({ reason: 'stake_out_of_range' });
    expect(elig().canPlay(guest, FUN(10_001n))).toMatchObject({ reason: 'stake_out_of_range' });
    expect(elig().canPlay(verified, USDT(101))).toMatchObject({ reason: 'stake_out_of_range' });
    expect(elig().canPlay(verified, USDT(100))).toEqual({ ok: true });
  });

  it('заблокированный не играет ни на чём', () => {
    const blocked = { ...guest, user: { kind: 'guest' as const, status: 'blocked' as const } };
    expect(elig().canPlay(blocked, FUN(100n))).toMatchObject({ reason: 'user_blocked' });
  });

  it('USDT требует KYC и совершеннолетия', () => {
    const noKyc = { ...verified, kyc: null };
    expect(elig().canPlay(noKyc, USDT(1))).toMatchObject({ reason: 'kyc_required' });
    expect(elig().canPlay(withKyc({ status: 'pending' }), USDT(1))).toMatchObject({
      reason: 'kyc_required',
    });
    expect(elig().canPlay(withKyc({ birthdate: '2010-01-01' }), USDT(1))).toMatchObject({
      reason: 'underage',
    });
    expect(
      elig({ kycRequiredForRealPlay: false }).canPlay({ ...noKyc, ipCountry: 'DE' }, USDT(1)),
    ).toEqual({
      ok: true,
    });
  });

  it('самоисключение блокирует USDT, но не FUN', () => {
    const excluded = {
      ...verified,
      settings: { adultOptIn: false, selfExcludedUntil: new Date('2027-01-01') },
    };
    expect(elig().canPlay(excluded, USDT(1))).toMatchObject({ reason: 'self_excluded' });
    expect(elig().canPlay(excluded, FUN(100n))).toEqual({ ok: true });
    const expired = {
      ...verified,
      settings: { adultOptIn: false, selfExcludedUntil: new Date('2026-01-01') },
    };
    expect(elig().canPlay(expired, USDT(1))).toEqual({ ok: true });
  });

  it('гео: проверяются и IP, и KYC-страна', () => {
    expect(elig().canPlay({ ...verified, ipCountry: null }, USDT(1))).toMatchObject({
      reason: 'geo_unknown',
    });
    expect(
      elig().canPlay({ ...withKyc({ country: 'US' }), ipCountry: 'US' }, USDT(1)),
    ).toMatchObject({
      reason: 'geo_blocked',
    });
    // VPN: IP в разрешённой стране, документы — из запрещённой.
    expect(elig().canPlay(withKyc({ country: 'US' }), USDT(1))).toMatchObject({
      reason: 'geo_blocked',
    });
    expect(elig().canPlay({ ...verified, ipCountry: 'FR' }, USDT(1))).toMatchObject({
      reason: 'geo_mismatch',
    });
    expect(
      elig({ requireMatch: false }).canPlay({ ...verified, ipCountry: 'FR' }, USDT(1)),
    ).toEqual({ ok: true });
  });
});

describe('canAdult', () => {
  it('нужны KYC, 18+, разрешённая страна по обоим источникам и opt-in', () => {
    expect(elig().canAdult(verified)).toEqual({ ok: true });
    expect(elig().canAdult(guest)).toMatchObject({ reason: 'kyc_required' });
    expect(elig().canAdult({ ...verified, ipCountry: 'FR' })).toMatchObject({
      reason: 'adult_unavailable',
    });
    expect(
      elig({ adultAllowed: new Set(['DE', 'FR']) }).canAdult({ ...verified, ipCountry: 'FR' }),
    ).toMatchObject({
      reason: 'geo_mismatch',
    });
    expect(
      elig().canAdult({ ...verified, settings: { adultOptIn: false, selfExcludedUntil: null } }),
    ).toMatchObject({
      reason: 'adult_opt_in_required',
    });
  });

  it('пустой список стран выключает 18+ везде', () => {
    expect(elig({ adultAllowed: new Set() }).canAdult(verified)).toMatchObject({
      reason: 'adult_unavailable',
    });
  });
});

describe('canStayX2', () => {
  it('ограничивает серию и проверяет удвоенную ставку', () => {
    expect(elig().canStayX2(guest, { ...FUN(100n), stayStreak: 0 })).toEqual({ ok: true });
    expect(elig().canStayX2(guest, { ...FUN(100n), stayStreak: 3 })).toMatchObject({
      reason: 'stay_streak_exceeded',
    });
    expect(elig().canStayX2(guest, { ...FUN(6_000n), stayStreak: 0 })).toMatchObject({
      reason: 'stake_out_of_range',
    });
  });
});

describe('canOpposite', () => {
  it('только с полом из KYC', () => {
    expect(elig().canOpposite(verified)).toEqual({ ok: true });
    expect(elig().canOpposite(guest)).toMatchObject({ reason: 'gender_unverified' });
    expect(elig().canOpposite(withKyc({ verifiedGender: null }))).toMatchObject({
      reason: 'gender_unverified',
    });
  });
});
