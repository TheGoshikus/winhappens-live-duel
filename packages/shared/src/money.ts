import { z } from 'zod';

/**
 * Деньги — целые minor units (bigint), одна расчётная валюта ledger (architecture §6.4).
 * Конвертация валют — только на границе платёжного шлюза.
 */
export type Minor = bigint;

/** 1 б.п. = 0.01%. Доли (rake и т.п.) задаются в б.п., чтобы не трогать float. */
export const BPS_DENOMINATOR = 10_000n;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

/** Строка из цифр в JSON → bigint. JSON не умеет bigint, поэтому на проводе суммы — строки. */
export const minorSchema = z
  .string()
  .regex(/^-?\d+$/, 'amount must be an integer string in minor units')
  .transform((s) => BigInt(s));

export const nonNegativeMinorSchema = minorSchema.refine((v) => v >= 0n, 'amount must be >= 0');
export const positiveMinorSchema = minorSchema.refine((v) => v > 0n, 'amount must be > 0');

export const toWire = (v: Minor): string => v.toString();

/** Доля суммы в б.п., с округлением вниз (в пользу игрока при rake). */
export function bpsOf(amount: Minor, bps: number): Minor {
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_DENOMINATOR)) {
    throw new MoneyError(`bps out of range: ${bps}`);
  }
  if (amount < 0n) throw new MoneyError('bpsOf expects a non-negative amount');
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Делит банк раунда 2S: приз победителю и rake. Сумма частей всегда равна банку. */
export function splitPot(pot: Minor, rakeBps: number): { prize: Minor; rake: Minor } {
  const rake = bpsOf(pot, rakeBps);
  return { prize: pot - rake, rake };
}

/** Парсинг десятичной строки ("12.34") в minor units без float. */
export function parseDecimal(input: string, exponent: number): Minor {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new MoneyError(`invalid decimal: ${input}`);
  const [, sign, int, frac = ''] = m;
  if (frac.length > exponent)
    throw new MoneyError(`too many fraction digits for exponent ${exponent}`);
  const v = BigInt(int + frac.padEnd(exponent, '0'));
  return sign ? -v : v;
}

export function formatDecimal(v: Minor, exponent: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(exponent + 1, '0');
  const out = exponent === 0 ? s : `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
  return neg ? `-${out}` : out;
}

/** USDT — реальные деньги (расчётная валюта ledger), FUN — фантики гостевой игры (docs/decisions.md). */
export const CURRENCIES = {
  USDT: { exponent: 6, real: true },
  FUN: { exponent: 2, real: false },
} as const;
export type Currency = keyof typeof CURRENCIES;
export const currencySchema = z.enum(['USDT', 'FUN']);
