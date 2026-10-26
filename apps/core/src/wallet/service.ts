import { settlePot, stakeFee, type Currency, type Minor } from '@winhappens/shared';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import type { AccountType } from '../db/schema.js';
import { post, type Leg, type PostResult } from './ledger.js';

type UserAccountType = Extract<AccountType, 'main' | 'session_hold' | 'pending_withdrawal'>;
type SystemAccountType = Exclude<AccountType, UserAccountType>;

export interface WalletSettings {
  funStartingBalance: Minor;
  /** Сбор со ставки каждого участника (229 = 2,29%). */
  stakeFeeBps: number;
  /** Комиссия с выигрыша: обычный раунд и режим взаимности. */
  winFeeBps: number;
  reciprocityWinFeeBps: number;
}

export interface Balances {
  main: Minor;
  hold: Minor;
  pendingWithdrawal: Minor;
}

/**
 * Операции кошелька (architecture §5, payments §5). Каждая — одна транзакция ledger
 * с идемпотентным ключом, производным от доменного события.
 */
export function createWalletService(db: Db, settings: WalletSettings) {
  const systemIds = new Map<string, string>();

  async function systemAccount(trx: Db, type: SystemAccountType, currency: Currency) {
    const key = `${type}:${currency}`;
    const cached = systemIds.get(key);
    if (cached) return cached;
    const row = await trx
      .selectFrom('wallet_account')
      .select('id')
      .where('user_id', 'is', null)
      .where('type', '=', type)
      .where('currency', '=', currency)
      .executeTakeFirstOrThrow();
    systemIds.set(key, row.id);
    return row.id;
  }

  async function userAccount(trx: Db, userId: string, type: UserAccountType, currency: Currency) {
    const find = () =>
      trx
        .selectFrom('wallet_account')
        .select('id')
        .where('user_id', '=', userId)
        .where('type', '=', type)
        .where('currency', '=', currency)
        .executeTakeFirst();
    const existing = await find();
    if (existing) return existing.id;
    await trx
      .insertInto('wallet_account')
      .values({ id: uuidv7(), user_id: userId, type, currency })
      .onConflict((oc) =>
        oc.columns(['user_id', 'type', 'currency']).where('user_id', 'is not', null).doNothing(),
      )
      .execute();
    return (await find())!.id;
  }

  /** Выполняет fn в новой транзакции БД или в переданной. */
  const tx = <T>(outer: Db | undefined, fn: (trx: Db) => Promise<T>) =>
    outer ? fn(outer) : db.transaction().execute(fn);

  const transfer = (
    trx: Db,
    kind: string,
    idempotencyKey: string,
    ref: { type: string; id: string },
    legs: Leg[],
  ): Promise<PostResult> => post(trx, { kind, idempotencyKey, ref, legs });

  const move = (from: string, to: string, amount: Minor): Leg[] => [
    { accountId: from, amount: -amount },
    { accountId: to, amount },
  ];

  return {
    /** Стартовые фантики гостя. Выдаются один раз на пользователя. */
    grantFunStarting(userId: string, outer?: Db) {
      return tx(outer, async (trx) =>
        transfer(
          trx,
          'fun.grant',
          `fun-start:${userId}`,
          { type: 'user', id: userId },
          move(
            await systemAccount(trx, 'fun_issuance', 'FUN'),
            await userAccount(trx, userId, 'main', 'FUN'),
            settings.funStartingBalance,
          ),
        ),
      );
    },

    /** deposit.succeeded от шлюза: gateway_clearing → main (payments §5). */
    creditDeposit(q: { userId: string; intentId: string; amount: Minor }, outer?: Db) {
      return tx(outer, async (trx) =>
        transfer(
          trx,
          'deposit',
          `deposit:${q.intentId}`,
          { type: 'payment_intent', id: q.intentId },
          move(
            await systemAccount(trx, 'gateway_clearing', 'USDT'),
            await userAccount(trx, q.userId, 'main', 'USDT'),
            q.amount,
          ),
        ),
      );
    },

    /** Депозит сессии D: main → session_hold. */
    hold(q: { userId: string; currency: Currency; amount: Minor; sessionId: string }, outer?: Db) {
      return tx(outer, async (trx) =>
        transfer(
          trx,
          'session.hold',
          `hold:${q.sessionId}:${q.userId}`,
          { type: 'session', id: q.sessionId },
          move(
            await userAccount(trx, q.userId, 'main', q.currency),
            await userAccount(trx, q.userId, 'session_hold', q.currency),
            q.amount,
          ),
        ),
      );
    },

    /** Конец сессии: весь остаток session_hold → main. Возвращает возвращённую сумму. */
    release(q: { userId: string; currency: Currency; sessionId: string }, outer?: Db) {
      return tx(outer, async (trx) => {
        const holdId = await userAccount(trx, q.userId, 'session_hold', q.currency);
        const { balance } = await trx
          .selectFrom('wallet_account')
          .select('balance')
          .where('id', '=', holdId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (balance === 0n) return { released: 0n };
        const mainId = await userAccount(trx, q.userId, 'main', q.currency);
        const r = await transfer(
          trx,
          'session.release',
          `release:${q.sessionId}:${q.userId}`,
          { type: 'session', id: q.sessionId },
          move(holdId, mainId, balance),
        );
        return { released: r.replayed ? 0n : balance };
      });
    },

    /**
     * Ставка S на коммите: S → round_pot, сбор со ставки → house_rake. Оба списываются с
     * session_hold, поэтому депозит сессии должен покрывать ставку вместе со сбором.
     */
    commitStake(
      q: { userId: string; currency: Currency; amount: Minor; roundId: string },
      outer?: Db,
    ) {
      const fee = stakeFee(q.amount, settings.stakeFeeBps);
      return tx(outer, async (trx) => {
        const r = await transfer(
          trx,
          'round.stake',
          `stake:${q.roundId}:${q.userId}`,
          { type: 'round', id: q.roundId },
          [
            {
              accountId: await userAccount(trx, q.userId, 'session_hold', q.currency),
              amount: -(q.amount + fee),
            },
            { accountId: await systemAccount(trx, 'round_pot', q.currency), amount: q.amount },
            { accountId: await systemAccount(trx, 'house_rake', q.currency), amount: fee },
          ],
        );
        return { ...r, fee };
      });
    },

    /** Раунд отменён до расчёта: ставка и сбор возвращаются в session_hold. */
    refundStake(
      q: { userId: string; currency: Currency; amount: Minor; roundId: string },
      outer?: Db,
    ) {
      const fee = stakeFee(q.amount, settings.stakeFeeBps);
      return tx(outer, async (trx) =>
        transfer(
          trx,
          'round.refund',
          `refund:${q.roundId}:${q.userId}`,
          { type: 'round', id: q.roundId },
          [
            { accountId: await systemAccount(trx, 'round_pot', q.currency), amount: -q.amount },
            { accountId: await systemAccount(trx, 'house_rake', q.currency), amount: -fee },
            {
              accountId: await userAccount(trx, q.userId, 'session_hold', q.currency),
              amount: q.amount + fee,
            },
          ],
        ),
      );
    },

    /**
     * Расчёт раунда: победитель получает банк минус комиссия с выигрыша (10%, во взаимности 20%)
     * сразу на main; комиссия → house_rake (docs/decisions.md).
     */
    settleRound(
      q: {
        currency: Currency;
        roundId: string;
        pot: Minor;
        winnerStake: Minor;
        winnerUserId: string;
        reciprocity?: boolean;
      },
      outer?: Db,
    ) {
      const { prize, winFee } = settlePot(
        q.pot,
        q.winnerStake,
        q.reciprocity ? settings.reciprocityWinFeeBps : settings.winFeeBps,
      );
      return tx(outer, async (trx) => {
        const potId = await systemAccount(trx, 'round_pot', q.currency);
        const r = await transfer(
          trx,
          'round.settle',
          `settle:${q.roundId}`,
          { type: 'round', id: q.roundId },
          [
            { accountId: potId, amount: -q.pot },
            {
              accountId: await userAccount(trx, q.winnerUserId, 'main', q.currency),
              amount: prize,
            },
            { accountId: await systemAccount(trx, 'house_rake', q.currency), amount: winFee },
          ],
        );
        return { ...r, prize, winFee };
      });
    },

    /** Заявка на вывод: main → pending_withdrawal (деньги заморожены до ответа шлюза). */
    requestWithdrawal(q: { userId: string; payoutId: string; amount: Minor }, outer?: Db) {
      return tx(outer, async (trx) =>
        transfer(
          trx,
          'withdrawal.request',
          `withdraw:${q.payoutId}`,
          { type: 'payout', id: q.payoutId },
          move(
            await userAccount(trx, q.userId, 'main', 'USDT'),
            await userAccount(trx, q.userId, 'pending_withdrawal', 'USDT'),
            q.amount,
          ),
        ),
      );
    },

    /** payout.succeeded → pending_withdrawal → gateway_clearing; payout.failed → обратно на main. */
    completeWithdrawal(
      q: { userId: string; payoutId: string; amount: Minor; succeeded: boolean },
      outer?: Db,
    ) {
      return tx(outer, async (trx) =>
        transfer(
          trx,
          q.succeeded ? 'withdrawal.succeeded' : 'withdrawal.failed',
          `withdraw-done:${q.payoutId}`,
          { type: 'payout', id: q.payoutId },
          move(
            await userAccount(trx, q.userId, 'pending_withdrawal', 'USDT'),
            q.succeeded
              ? await systemAccount(trx, 'gateway_clearing', 'USDT')
              : await userAccount(trx, q.userId, 'main', 'USDT'),
            q.amount,
          ),
        ),
      );
    },

    async balances(userId: string): Promise<Record<Currency, Balances>> {
      const rows = await db
        .selectFrom('wallet_account')
        .select(['type', 'currency', 'balance'])
        .where('user_id', '=', userId)
        .execute();
      const empty = (): Balances => ({ main: 0n, hold: 0n, pendingWithdrawal: 0n });
      const out: Record<Currency, Balances> = { USDT: empty(), FUN: empty() };
      for (const r of rows) {
        const b = out[r.currency];
        if (r.type === 'main') b.main = r.balance;
        else if (r.type === 'session_hold') b.hold = r.balance;
        else if (r.type === 'pending_withdrawal') b.pendingWithdrawal = r.balance;
      }
      return out;
    },

    /** История основного счёта, новые сверху; курсор — id проводки. */
    async history(
      userId: string,
      currency: Currency,
      q: { limit: number; before?: bigint | undefined },
    ) {
      let query = db
        .selectFrom('ledger_entry as e')
        .innerJoin('wallet_account as a', 'a.id', 'e.account_id')
        .innerJoin('ledger_tx as t', 't.id', 'e.tx_id')
        .select([
          'e.id',
          'e.amount',
          'e.balance_after',
          'e.created_at',
          't.kind',
          't.ref_type',
          't.ref_id',
        ])
        .where('a.user_id', '=', userId)
        .where('a.type', '=', 'main')
        .where('a.currency', '=', currency)
        .orderBy('e.id', 'desc')
        .limit(q.limit);
      if (q.before !== undefined) query = query.where('e.id', '<', q.before);
      return query.execute();
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
