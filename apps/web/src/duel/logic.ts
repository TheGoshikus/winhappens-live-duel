import {
  BET_WINDOW_SEC,
  DEALERS,
  DONE_AFTER_MS,
  ITEMS,
  RECIPROCITY_WIN_FEE_BPS,
  STAKE_FEE_BPS,
  WIN_FEE_BPS,
  REVEAL_AFTER_MS,
  ROUNDS_TO_RECIPROCITY,
  START_BALANCE,
  itemById,
  type ItemId,
} from './data';

export type Phase = 'pick' | 'wait' | 'reveal' | 'done';

export interface Round {
  phase: Phase;
  pick: number | null;
  stake: number;
  chip: number;
  item: ItemId | null;
  /** Сыгранные раунды с этим крупье — заполняют кольцо. */
  count: number;
  dealerPick: number | null;
  /** Когда начался приём ставок / когда закончится текущая фаза (мс). */
  startedAt: number;
  phaseEndsAt: number | null;
}

export interface HistoryEntry {
  dealer: number;
  won: boolean;
  /** Чистый результат раунда в сотых: выигрыш за вычетом ставки и сбора, либо потеря. */
  amount: number;
}

export interface DuelState {
  dealer: number;
  rounds: Record<number, Round>;
  stake: number;
  chip: number;
  /** Баланс в сотых долях фишки. */
  balance: number;
  mode: Record<number, 'items' | null>;
  removed: Record<number, ItemId[]>;
  item: ItemId | null;
  /** Крупье, для которого показать модалку взаимности. */
  offer: number | null;
  full: boolean;
  history: HistoryEntry[];
}

export type Action =
  | { type: 'select'; dealer: number; now: number }
  | { type: 'step'; dir: 1 | -1; now: number }
  | { type: 'pick'; n: number }
  | { type: 'chip'; value: number }
  | { type: 'half' }
  | { type: 'double' }
  | { type: 'item'; id: ItemId }
  | { type: 'confirm'; now: number }
  | { type: 'reveal'; dealer: number; now: number }
  | { type: 'finish'; dealer: number }
  | { type: 'nextRound'; now: number }
  | { type: 'acceptOffer'; now: number }
  | { type: 'dismissOffer' }
  | { type: 'full'; open: boolean };

/** Игрок всегда ЧЁТ (место 0): побеждает при чётной сумме. */
export const isEven = (n: number) => n % 2 === 0;
export const playerWins = (pick: number, dealerPick: number) => isEven(pick + dealerPick);
/** Сотых в одной фишке. Ставки — в целых фишках, баланс и комиссии — в сотых. */
export const CENT = 100;
const bps = (cents: number, b: number) => Math.floor((cents * b) / 10_000);
/** Сбор 2,29% со ставки при любом исходе, округление вниз (как в ledger). */
export const stakeFeeCents = (stake: number) => bps(stake * CENT, STAKE_FEE_BPS);
/** Сколько стоит поставить: ставка + сбор. */
export const costCents = (stake: number) => stake * CENT + stakeFeeCents(stake);
/** Выплата победителю: банк минус 10% с выигрыша (во взаимности 20%). */
export const payoutCents = (stake: number, reciprocity = false) =>
  2 * stake * CENT - bps(stake * CENT, reciprocity ? RECIPROCITY_WIN_FEE_BPS : WIN_FEE_BPS);
/** Наибольшая ставка, которую покрывает баланс вместе со сбором. */
export function maxStake(balance: number): number {
  let s = Math.floor((balance * 10_000) / (CENT * (10_000 + STAKE_FEE_BPS)));
  while (costCents(s + 1) <= balance) s += 1;
  return s;
}
/** 1234 → «12,34», 1900 → «19». */
export const fmtMoney = (cents: number) =>
  (cents / CENT).toLocaleString('ru-RU', {
    minimumFractionDigits: cents % CENT ? 2 : 0,
    maximumFractionDigits: 2,
  });
/** Число крупье в демо: по формуле ТЗ, сдвинутое на номер раунда, чтобы исход менялся. */
export const demoDealerPick = (dealer: number, count: number) => (dealer * 3 + 3 + count) % 10;

const newRound = (count: number, now: number, stake: number, chip: number): Round => ({
  phase: 'pick',
  pick: null,
  stake,
  chip,
  item: null,
  count,
  dealerPick: null,
  startedAt: now,
  phaseEndsAt: null,
});

export function initialState(now: number, dealer = 0): DuelState {
  const d = DEALERS[dealer]!;
  const stake = Math.max(5, d.min);
  return {
    dealer,
    rounds: { [dealer]: newRound(0, now, stake, 5) },
    stake,
    chip: 5,
    balance: START_BALANCE * CENT,
    mode: {},
    removed: {},
    item: null,
    offer: null,
    full: false,
    history: [],
  };
}

export function roundOf(s: DuelState, dealer: number, now = 0): Round {
  return s.rounds[dealer] ?? newRound(0, now, s.stake, s.chip);
}

/** Следующий свободный крупье по кругу в направлении dir. */
export function stepDealer(from: number, dir: 1 | -1): number {
  const n = DEALERS.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n * k) % n;
    if (!DEALERS[i]!.busy) return i;
  }
  return from;
}

function selectDealer(s: DuelState, dealer: number, now: number): DuelState {
  const d = DEALERS[dealer];
  if (!d || d.busy || dealer === s.dealer) return s;
  const rounds = s.rounds[dealer]
    ? s.rounds
    : { ...s.rounds, [dealer]: newRound(0, now, s.stake, s.chip) };
  return { ...s, dealer, rounds, stake: Math.max(s.stake, d.min), item: null };
}

function updateRound(s: DuelState, dealer: number, patch: Partial<Round>): DuelState {
  return { ...s, rounds: { ...s.rounds, [dealer]: { ...roundOf(s, dealer), ...patch } } };
}

export function reducer(s: DuelState, a: Action): DuelState {
  const cur = roundOf(s, s.dealer);
  const picking = cur.phase === 'pick';
  switch (a.type) {
    case 'select':
      return selectDealer(s, a.dealer, a.now);
    case 'step':
      return selectDealer(s, stepDealer(s.dealer, a.dir), a.now);
    case 'pick':
      if (!picking || a.n < 0 || a.n > 9) return s;
      return updateRound(s, s.dealer, { pick: a.n });
    case 'chip':
      return picking ? { ...s, chip: a.value, stake: a.value } : s;
    case 'half':
      return picking ? { ...s, stake: Math.max(1, Math.floor(s.stake / 2)) } : s;
    case 'double':
      return picking ? { ...s, stake: Math.max(1, Math.min(maxStake(s.balance), s.stake * 2)) } : s;
    case 'item': {
      const item = itemById(a.id);
      if (
        !picking ||
        !item ||
        s.mode[s.dealer] !== 'items' ||
        (s.removed[s.dealer] ?? []).includes(a.id)
      )
        return s;
      return { ...s, item: a.id, stake: item.price };
    }
    case 'confirm': {
      if (!canConfirm(s)) return s;
      return {
        ...updateRound(s, s.dealer, {
          phase: 'wait',
          stake: s.stake,
          chip: s.chip,
          item: s.mode[s.dealer] === 'items' ? s.item : null,
          phaseEndsAt: a.now + REVEAL_AFTER_MS,
        }),
        balance: s.balance - costCents(s.stake),
      };
    }
    case 'reveal': {
      const r = roundOf(s, a.dealer);
      if (r.phase !== 'wait') return s;
      return updateRound(s, a.dealer, {
        phase: 'reveal',
        dealerPick: demoDealerPick(a.dealer, r.count),
        phaseEndsAt: a.now + DONE_AFTER_MS,
      });
    }
    case 'finish': {
      const r = roundOf(s, a.dealer);
      if (r.phase !== 'reveal' || r.pick === null || r.dealerPick === null) return s;
      const won = playerWins(r.pick, r.dealerPick);
      const payout = payoutCents(r.stake, r.item !== null);
      const cost = costCents(r.stake);
      const count = r.count + 1;
      let next = updateRound(s, a.dealer, { phase: 'done', count, phaseEndsAt: null });
      next = {
        ...next,
        balance: next.balance + (won ? payout : 0),
        history: [
          ...next.history,
          { dealer: a.dealer, won, amount: won ? payout - cost : cost },
        ].slice(-20),
      };
      if (won && r.item)
        next = {
          ...next,
          removed: { ...next.removed, [a.dealer]: [...(next.removed[a.dealer] ?? []), r.item] },
        };
      if (count === ROUNDS_TO_RECIPROCITY && next.mode[a.dealer] !== 'items' && next.offer === null)
        next = { ...next, offer: a.dealer };
      return next;
    }
    case 'nextRound': {
      if (cur.phase !== 'done') return s;
      const min = DEALERS[s.dealer]!.min;
      return {
        ...s,
        item: null,
        stake: Math.max(min, Math.min(s.stake, maxStake(s.balance))),
        rounds: { ...s.rounds, [s.dealer]: newRound(cur.count, a.now, s.stake, s.chip) },
      };
    }
    case 'acceptOffer': {
      if (s.offer === null) return s;
      const dealer = s.offer;
      const moved = dealer === s.dealer ? s : selectDealer(s, dealer, a.now);
      return { ...moved, offer: null, item: null, mode: { ...moved.mode, [dealer]: 'items' } };
    }
    case 'dismissOffer':
      return { ...s, offer: null };
    case 'full':
      return { ...s, full: a.open };
  }
}

export function canConfirm(s: DuelState): boolean {
  const r = roundOf(s, s.dealer);
  if (r.phase !== 'pick' || r.pick === null) return false;
  if (s.stake < 1 || costCents(s.stake) > s.balance) return false;
  if (s.mode[s.dealer] === 'items' && !s.item) return false;
  return true;
}

export function ctaLabel(s: DuelState): string {
  const r = roundOf(s, s.dealer);
  const items = s.mode[s.dealer] === 'items';
  if (r.phase === 'wait' || r.phase === 'reveal') return 'Ждём крупье… можно листать';
  if (r.phase === 'done') return 'Следующий раунд';
  if (items && !s.item) return 'Выберите предмет';
  if (r.pick === null) return 'Выберите число';
  if (items) return `${s.stake} на ${r.pick} · против «${itemById(s.item)!.name}»`;
  return `Ставка ${s.stake} на ${r.pick}`;
}

export function caption(s: DuelState, dealer = s.dealer): string {
  const r = roundOf(s, dealer);
  switch (r.phase) {
    case 'pick':
      return 'ДЕЛАЙТЕ СТАВКИ';
    case 'wait':
      return 'СТАВКИ СДЕЛАНЫ';
    case 'reveal':
      return `${r.pick} + ${r.dealerPick} = ${r.pick! + r.dealerPick!}`;
    case 'done': {
      if (!playerWins(r.pick!, r.dealerPick!))
        return `${DEALERS[dealer]!.name.toUpperCase()} ЗАБИРАЕТ`;
      const item = itemById(r.item);
      return item
        ? `ПОБЕДА · ${item.name.toUpperCase()} СНИМАЕТСЯ`
        : `ПОБЕДА +${fmtMoney(payoutCents(r.stake))}`;
    }
  }
}

/** Бейдж на соседнем кружке: ● раунд идёт, +N / −N итог. */
export function badge(
  s: DuelState,
  dealer: number,
): { kind: 'live' | 'win' | 'loss'; text: string } | null {
  const r = s.rounds[dealer];
  if (!r || r.phase === 'pick') return null;
  if (r.phase !== 'done') return { kind: 'live', text: '●' };
  return playerWins(r.pick!, r.dealerPick!)
    ? {
        kind: 'win',
        text: `+${fmtMoney(payoutCents(r.stake, r.item !== null) - costCents(r.stake))}`,
      }
    : { kind: 'loss', text: `−${fmtMoney(costCents(r.stake))}` };
}

/** Секунды для пилюли таймера и открыт ли приём ставок. */
export function timerOf(
  s: DuelState,
  now: number,
  dealer = s.dealer,
): { sec: number; open: boolean } {
  const r = roundOf(s, dealer, now);
  if (r.phase === 'pick') {
    const elapsed = Math.floor((now - r.startedAt) / 1000);
    return {
      sec:
        BET_WINDOW_SEC -
        (((elapsed % (BET_WINDOW_SEC + 1)) + BET_WINDOW_SEC + 1) % (BET_WINDOW_SEC + 1)),
      open: true,
    };
  }
  return {
    sec: r.phaseEndsAt ? Math.max(0, Math.ceil((r.phaseEndsAt - now) / 1000)) : 0,
    open: false,
  };
}

export const fmtSec = (sec: number) => `0:${String(sec).padStart(2, '0')}`;
export { ITEMS };
