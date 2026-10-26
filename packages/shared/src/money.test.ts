import { describe, expect, it } from 'vitest';
import {
  bpsOf,
  formatDecimal,
  minorSchema,
  MoneyError,
  parseDecimal,
  settlePot,
  stakeFee,
} from './money.js';

describe('money', () => {
  it('settlePot: комиссия только с выигрыша, части в сумме дают банк', () => {
    // Ставки по 10 USDT: выигрыш 10, комиссия 10% → приз 19.
    expect(settlePot(20_000_000n, 10_000_000n, 1_000)).toEqual({
      prize: 19_000_000n,
      winFee: 1_000_000n,
    });
    // Взаимность — 20%.
    expect(settlePot(20_000_000n, 10_000_000n, 2_000)).toEqual({
      prize: 18_000_000n,
      winFee: 2_000_000n,
    });
    for (const [pot, stake] of [
      [0n, 0n],
      [3n, 1n],
      [199n, 99n],
      [10n ** 18n, 4n * 10n ** 17n],
    ] as const) {
      for (const bps of [0, 1, 1_000, 2_000, 10_000]) {
        const { prize, winFee } = settlePot(pot, stake, bps);
        expect(prize + winFee).toBe(pot);
        expect(winFee).toBe(((pot - stake) * BigInt(bps)) / 10_000n);
      }
    }
    expect(() => settlePot(10n, 11n, 1_000)).toThrow(MoneyError);
  });

  it('stakeFee: 2,29% со ставки, округление вниз', () => {
    expect(stakeFee(10_000_000n, 229)).toBe(229_000n);
    expect(stakeFee(1_000_000n, 229)).toBe(22_900n);
    expect(stakeFee(100n, 229)).toBe(2n);
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
