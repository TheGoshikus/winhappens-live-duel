import { describe, expect, it } from 'vitest';
import { DEALERS } from './data';
import {
  badge,
  canConfirm,
  caption,
  ctaLabel,
  initialState,
  playerWins,
  reducer,
  roundOf,
  stepDealer,
  timerOf,
  costCents,
  fmtMoney,
  maxStake,
  payoutCents,
  stakeFeeCents,
  type Action,
  type DuelState,
} from './logic';

const run = (s: DuelState, ...actions: Action[]) => actions.reduce(reducer, s);
const T = 1_000_000;

/** Полный раунд у текущего крупье с выбранным числом. */
const playRound = (s: DuelState, n: number) => {
  const d = s.dealer;
  return run(
    s,
    { type: 'pick', n },
    { type: 'confirm', now: T },
    { type: 'reveal', dealer: d, now: T },
    { type: 'finish', dealer: d },
  );
};

describe('правила', () => {
  it('игрок — ЧЁТ: побеждает при чётной сумме', () => {
    expect(playerWins(2, 4)).toBe(true);
    expect(playerWins(3, 4)).toBe(false);
  });

  it('комиссия: 2,29% со ставки + 10% с выигрыша (во взаимности 20%)', () => {
    expect(stakeFeeCents(10)).toBe(22);
    expect(stakeFeeCents(100)).toBe(229);
    expect(costCents(10)).toBe(1022);
    expect(payoutCents(10)).toBe(1900);
    expect(payoutCents(10, true)).toBe(1800);
    expect(payoutCents(5)).toBe(950);
    expect(fmtMoney(1900)).toBe('19');
    expect(fmtMoney(950)).toBe('9,50');
    expect(maxStake(3000)).toBe(29);
    expect(costCents(maxStake(3000) + 1)).toBeGreaterThan(3000);
  });

  it('листание пропускает занятых крупье по кругу', () => {
    expect(DEALERS[3]!.busy).toBe(true);
    expect(stepDealer(2, 1)).toBe(4);
    expect(stepDealer(4, -1)).toBe(2);
    expect(stepDealer(0, -1)).toBe(11);
    expect(stepDealer(9, 1)).toBe(11);
  });

  it('смена крупье поднимает ставку до его минимума', () => {
    const s = run(
      initialState(T),
      { type: 'chip', value: 1 },
      { type: 'select', dealer: 4, now: T },
    );
    expect(s.dealer).toBe(4);
    expect(s.stake).toBe(25);
    expect(run(s, { type: 'select', dealer: 3, now: T }).dealer).toBe(4); // занятая
  });
});

describe('ставка', () => {
  it('½ и 2× в пределах баланса; фишка задаёт ставку', () => {
    let s = run(initialState(T), { type: 'chip', value: 25 });
    expect(s.stake).toBe(25);
    s = run(
      s,
      { type: 'half' },
      { type: 'half' },
      { type: 'half' },
      { type: 'half' },
      { type: 'half' },
    );
    expect(s.stake).toBe(1);
    // Удвоение упирается в баланс вместе со сбором: на 30 фишек можно поставить 29.
    s = run({ ...s, balance: 3000, stake: 20 }, { type: 'double' });
    expect(s.stake).toBe(29);
  });

  it('CTA проходит все состояния', () => {
    let s = initialState(T);
    expect(ctaLabel(s)).toBe('Выберите число');
    expect(canConfirm(s)).toBe(false);
    s = run(s, { type: 'pick', n: 7 });
    expect(ctaLabel(s)).toBe('Ставка 5 на 7');
    s = run(s, { type: 'confirm', now: T });
    expect(ctaLabel(s)).toBe('Ждём крупье… можно листать');
    expect(s.balance).toBe(100_000 - 511);
    expect(run(s, { type: 'chip', value: 100 }).stake).toBe(5); // после ставки менять нельзя
    s = run(s, { type: 'reveal', dealer: 0, now: T }, { type: 'finish', dealer: 0 });
    expect(ctaLabel(s)).toBe('Следующий раунд');
    s = run(s, { type: 'nextRound', now: T });
    expect(roundOf(s, 0)).toMatchObject({ phase: 'pick', pick: null, count: 1 });
  });

  it('caption и баланс по итогу раунда', () => {
    // Крупье 0 в первом раунде выбирает 3: нечётное число игрока даёт чётную сумму.
    let s = run(initialState(T), { type: 'pick', n: 1 }, { type: 'confirm', now: T });
    expect(caption(s)).toBe('СТАВКИ СДЕЛАНЫ');
    s = run(s, { type: 'reveal', dealer: 0, now: T });
    expect(caption(s)).toBe('1 + 3 = 4');
    s = run(s, { type: 'finish', dealer: 0 });
    expect(caption(s)).toBe('ПОБЕДА +9,50');
    expect(s.balance).toBe(100_000 - 511 + 950);

    const lost = playRound(initialState(T), 2);
    expect(caption(lost)).toBe('АЛИНА ЗАБИРАЕТ');
    expect(lost.balance).toBe(100_000 - 511);
  });

  it('раунды у разных крупье идут параллельно, бейджи у соседей', () => {
    let s = run(
      initialState(T),
      { type: 'pick', n: 1 },
      { type: 'confirm', now: T },
      { type: 'step', dir: 1, now: T },
    );
    expect(s.dealer).toBe(1);
    expect(badge(s, 0)).toEqual({ kind: 'live', text: '●' });
    s = run(s, { type: 'pick', n: 0 }, { type: 'confirm', now: T });
    s = run(s, { type: 'reveal', dealer: 0, now: T }, { type: 'finish', dealer: 0 });
    expect(badge(s, 0)).toEqual({ kind: 'win', text: '+4,39' });
    expect(roundOf(s, 1).phase).toBe('wait');
  });

  it('таймер: обратный отсчёт приёма ставок, затем секунды до следующей фазы', () => {
    const s = initialState(T);
    expect(timerOf(s, T + 3_200)).toEqual({ sec: 12, open: true });
    const w = run(s, { type: 'pick', n: 1 }, { type: 'confirm', now: T });
    expect(timerOf(w, T + 1_500)).toEqual({ sec: 3, open: false });
  });
});

describe('взаимность', () => {
  it('3 раунда заполняют кольцо и открывают предложение', () => {
    let s = initialState(T);
    for (let i = 0; i < 3; i++) {
      expect(s.offer).toBeNull();
      s = run(playRound(s, 1), { type: 'nextRound', now: T });
    }
    expect(s.offer).toBe(0);
    expect(roundOf(s, 0).count).toBe(3);
    s = run(s, { type: 'acceptOffer', now: T });
    expect(s.mode[0]).toBe('items');
    expect(s.offer).toBeNull();
  });

  it('предмет задаёт ставку; при победе снимается и больше недоступен', () => {
    let s: DuelState = { ...initialState(T), mode: { 0: 'items' } };
    s = run(s, { type: 'pick', n: 1 });
    expect(ctaLabel(s)).toBe('Выберите предмет');
    expect(canConfirm(s)).toBe(false);
    s = run(s, { type: 'item', id: 'scarf' });
    expect(s.stake).toBe(10);
    expect(ctaLabel(s)).toBe('10 на 1 · против «Шарф»');
    s = run(
      s,
      { type: 'confirm', now: T },
      { type: 'reveal', dealer: 0, now: T },
      { type: 'finish', dealer: 0 },
    );
    expect(caption(s)).toBe('ПОБЕДА · ШАРФ СНИМАЕТСЯ');
    expect(s.removed[0]).toEqual(['scarf']);
    // Взаимность: 20% с выигрыша.
    expect(s.balance).toBe(100_000 - 1022 + 1800);
    s = run(s, { type: 'nextRound', now: T }, { type: 'item', id: 'scarf' });
    expect(s.item).toBeNull();
  });

  it('предметы недоступны без режима взаимности', () => {
    expect(run(initialState(T), { type: 'item', id: 'hat' }).item).toBeNull();
  });
});
