import { describe, expect, it } from 'vitest';
import { bpsOf, formatDecimal, minorSchema, MoneyError, parseDecimal, splitPot } from './money.js';

describe('money', () => {
  it('splitPot сохраняет сумму и округляет rake вниз', () => {
    for (const pot of [0n, 1n, 199n, 200n, 12_345n, 10n ** 18n]) {
      for (const bps of [0, 1, 500, 999, 10_000]) {
        const { prize, rake } = splitPot(pot, bps);
        expect(prize + rake).toBe(pot);
        expect(rake).toBe((pot * BigInt(bps)) / 10_000n);
      }
    }
  });

  it('bpsOf отклоняет некорректные доли', () => {
    expect(() => bpsOf(100n, -1)).toThrow(MoneyError);
    expect(() => bpsOf(100n, 10_001)).toThrow(MoneyError);
    expect(() => bpsOf(100n, 1.5)).toThrow(MoneyError);
  });

  it('parse/format десятичных без float', () => {
    expect(parseDecimal('12.34', 2)).toBe(1234n);
    expect(parseDecimal('0.1', 6)).toBe(100_000n);
    expect(parseDecimal('-5', 2)).toBe(-500n);
    expect(() => parseDecimal('1.234', 2)).toThrow(MoneyError);
    expect(() => parseDecimal('1e3', 2)).toThrow(MoneyError);
    expect(formatDecimal(1234n, 2)).toBe('12.34');
    expect(formatDecimal(5n, 2)).toBe('0.05');
    expect(formatDecimal(-500n, 2)).toBe('-5.00');
    expect(formatDecimal(42n, 0)).toBe('42');
  });

  it('minorSchema принимает только целые строки', () => {
    expect(minorSchema.parse('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(minorSchema.safeParse('1.5').success).toBe(false);
    expect(minorSchema.safeParse(15).success).toBe(false);
  });
});
