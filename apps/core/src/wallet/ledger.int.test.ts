import fc from 'fast-check';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { startTestDb } from '../test/postgres.js';
import { InsufficientFundsError, LedgerError, normalizeLegs } from './ledger.js';
import { createWalletService, type WalletService } from './service.js';

let db: Db;
let stop: () => Promise<void>;
let wallet: WalletService;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  wallet = createWalletService(db, {
    funStartingBalance: 100_000n,
    stakeFeeBps: 229,
    winFeeBps: 1_000,
    reciprocityWinFeeBps: 2_000,
  });
});
afterAll(async () => stop?.());

async function newUser() {
  const id = uuidv7();
  await db
    .insertInto('users')
    .values({ id, kind: 'registered', nickname: null, ip_country: 'DE' })
    .execute();
  return id;
}

/** Глобальные инварианты ledger — должны держаться после любой последовательности операций. */
async function assertInvariants() {
  const perCurrency = await sql<{ currency: string; total: string }>`
    select currency, sum(balance)::text as total from wallet_account group by currency`.execute(db);
  for (const r of perCurrency.rows)
    expect(BigInt(r.total), `sum of ${r.currency} balances`).toBe(0n);

  const unbalanced =
    await sql`select tx_id from ledger_entry group by tx_id having sum(amount) <> 0`.execute(db);
  expect(unbalanced.rows).toEqual([]);

  const drift = await sql`
    select a.id from wallet_account a left join ledger_entry e on e.account_id = a.id
    group by a.id, a.balance having a.balance <> coalesce(sum(e.amount), 0)`.execute(db);
  expect(drift.rows, 'cached balance equals sum of entries').toEqual([]);

  const negative =
    await sql`select id from wallet_account where balance < 0 and not allow_negative`.execute(db);
  expect(negative.rows).toEqual([]);
}

const balance = async (userId: string, currency: 'USDT' | 'FUN' = 'USDT') =>
  (await wallet.balances(userId))[currency];

describe('normalizeLegs', () => {
  it('схлопывает ноги и отвергает несбалансированное', () => {
    expect(
      normalizeLegs([
        { accountId: 'a', amount: 5n },
        { accountId: 'a', amount: -2n },
        { accountId: 'b', amount: -3n },
      ]),
    ).toEqual([
      { accountId: 'a', amount: 3n },
      { accountId: 'b', amount: -3n },
    ]);
    expect(() => normalizeLegs([{ accountId: 'a', amount: 1n }])).toThrow(LedgerError);
    expect(() =>
      normalizeLegs([
        { accountId: 'a', amount: 1n },
        { accountId: 'a', amount: -1n },
      ]),
    ).toThrow(LedgerError);
  });
});

describe('инварианты в БД', () => {
  it('несбалансированная транзакция откатывается при коммите', async () => {
    const u = await newUser();
    await wallet.grantFunStarting(u);
    const [acc] = await db
      .selectFrom('wallet_account')
      .select('id')
      .where('user_id', '=', u)
      .execute();
    const attempt = db.transaction().execute(async (trx) => {
      const txId = uuidv7();
      await trx
        .insertInto('ledger_tx')
        .values({ id: txId, kind: 'hack', ref_type: null, ref_id: null, idempotency_key: null })
        .execute();
      await trx
        .insertInto('ledger_entry')
        .values({ tx_id: txId, account_id: acc!.id, amount: 1n, balance_after: 0n })
        .execute();
    });
    await expect(attempt).rejects.toThrow(/unbalanced/);
  });

  it('проводки нельзя менять и удалять; минус без разрешения запрещён', async () => {
    await expect(sql`update ledger_entry set amount = amount + 1`.execute(db)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from ledger_tx`.execute(db)).rejects.toThrow(/append-only/);
    const u = await newUser();
    await wallet.grantFunStarting(u);
    await expect(
      sql`update wallet_account set balance = -1 where user_id = ${u}`.execute(db),
    ).rejects.toThrow(/wallet_account_balance_check/);
  });
});

describe('операции', () => {
  it('стартовые фантики выдаются один раз', async () => {
    const u = await newUser();
    expect((await wallet.grantFunStarting(u)).replayed).toBe(false);
    expect((await wallet.grantFunStarting(u)).replayed).toBe(true);
    expect((await balance(u, 'FUN')).main).toBe(100_000n);
  });

  it('повторная доставка deposit.succeeded не начисляет дважды, в том числе параллельно', async () => {
    const u = await newUser();
    const intentId = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        wallet.creditDeposit({ userId: u, intentId, amount: 5_000_000n }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.txId)).size).toBe(1);
    expect((await balance(u)).main).toBe(5_000_000n);
  });

  it('параллельные списания не уводят баланс в минус', async () => {
    const u = await newUser();
    await wallet.creditDeposit({ userId: u, intentId: uuidv7(), amount: 100n });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        wallet.hold({ userId: u, currency: 'USDT', amount: 10n, sessionId: uuidv7() }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o) => o.status === 'rejected');
    expect(ok).toHaveLength(10);
    for (const f of failed)
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    expect(await balance(u)).toMatchObject({ main: 0n, hold: 100n });
    await assertInvariants();
  });

  it('полный круг сессии: hold → ставки со сбором 2,29% → расчёт с 10% с выигрыша → release', async () => {
    const [a, b] = [await newUser(), await newUser()];
    for (const u of [a, b])
      await wallet.creditDeposit({ userId: u, intentId: uuidv7(), amount: 10_000_000n });
    const sessionId = uuidv7();
    const S = 1_000_000n;
    const FEE = 22_900n; // 2,29% от 1 USDT
    for (const u of [a, b])
      await wallet.hold({ userId: u, currency: 'USDT', amount: 5n * S, sessionId });

    const roundId = uuidv7();
    for (const u of [a, b])
      expect(
        (await wallet.commitStake({ userId: u, currency: 'USDT', amount: S, roundId })).fee,
      ).toBe(FEE);
    const settled = await wallet.settleRound({
      currency: 'USDT',
      roundId,
      pot: 2n * S,
      winnerStake: S,
      winnerUserId: a,
    });
    expect(settled).toMatchObject({ prize: 1_900_000n, winFee: 100_000n, replayed: false });
    expect(
      (
        await wallet.settleRound({
          currency: 'USDT',
          roundId,
          pot: 2n * S,
          winnerStake: S,
          winnerUserId: b,
        })
      ).replayed,
    ).toBe(true);

    expect(await balance(a)).toMatchObject({ main: 5_000_000n + 1_900_000n, hold: 4n * S - FEE });
    expect(await balance(b)).toMatchObject({ main: 5_000_000n, hold: 4n * S - FEE });

    expect((await wallet.release({ userId: a, currency: 'USDT', sessionId })).released).toBe(
      4n * S - FEE,
    );
    expect((await wallet.release({ userId: a, currency: 'USDT', sessionId })).released).toBe(0n);
    await wallet.release({ userId: b, currency: 'USDT', sessionId });
    // Победитель: +1 − 0,1 − 0,0229 = +0,8771; проигравший: −1 − 0,0229.
    expect(await balance(a)).toMatchObject({ main: 10_877_100n, hold: 0n });
    expect(await balance(b)).toMatchObject({ main: 8_977_100n, hold: 0n });
    await assertInvariants();
  });

  it('взаимность: 20% с выигрыша; отмена раунда возвращает ставку со сбором', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const S = 10_000_000n;
    for (const u of [a, b]) {
      await wallet.creditDeposit({ userId: u, intentId: uuidv7(), amount: 30_000_000n });
      await wallet.hold({ userId: u, currency: 'USDT', amount: 30_000_000n, sessionId: `s-${a}` });
    }
    const roundId = uuidv7();
    for (const u of [a, b])
      await wallet.commitStake({ userId: u, currency: 'USDT', amount: S, roundId });
    const settled = await wallet.settleRound({
      currency: 'USDT',
      roundId,
      pot: 2n * S,
      winnerStake: S,
      winnerUserId: b,
      reciprocity: true,
    });
    expect(settled).toMatchObject({ prize: 18_000_000n, winFee: 2_000_000n });
    expect(await balance(b)).toMatchObject({ main: 18_000_000n, hold: 20_000_000n - 229_000n });

    const cancelled = uuidv7();
    await wallet.commitStake({ userId: a, currency: 'USDT', amount: S, roundId: cancelled });
    await wallet.refundStake({ userId: a, currency: 'USDT', amount: S, roundId: cancelled });
    expect((await balance(a)).hold).toBe(20_000_000n - 229_000n);
    await assertInvariants();
  });

  it('вывод: заморозка, затем успех или возврат', async () => {
    const u = await newUser();
    await wallet.creditDeposit({ userId: u, intentId: uuidv7(), amount: 3_000_000n });
    const [p1, p2] = [uuidv7(), uuidv7()];
    await wallet.requestWithdrawal({ userId: u, payoutId: p1, amount: 1_000_000n });
    await wallet.requestWithdrawal({ userId: u, payoutId: p2, amount: 1_000_000n });
    expect(await balance(u)).toMatchObject({ main: 1_000_000n, pendingWithdrawal: 2_000_000n });
    await wallet.completeWithdrawal({
      userId: u,
      payoutId: p1,
      amount: 1_000_000n,
      succeeded: true,
    });
    await wallet.completeWithdrawal({
      userId: u,
      payoutId: p2,
      amount: 1_000_000n,
      succeeded: false,
    });
    expect(await balance(u)).toMatchObject({ main: 2_000_000n, pendingWithdrawal: 0n });
    await expect(
      wallet.requestWithdrawal({ userId: u, payoutId: uuidv7(), amount: 2_000_001n }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    await assertInvariants();
  });
});

describe('property: случайные последовательности операций', () => {
  type Op =
    | { op: 'deposit'; amount: bigint }
    | { op: 'hold'; amount: bigint }
    | { op: 'release' }
    | { op: 'withdraw'; amount: bigint }
    | { op: 'withdrawDone'; succeeded: boolean }
    | { op: 'replayDeposit' };

  const amount = fc.bigInt({ min: 1n, max: 1_000n });
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant('deposit' as const), amount }),
    fc.record({ op: fc.constant('hold' as const), amount }),
    fc.record({ op: fc.constant('release' as const) }),
    fc.record({ op: fc.constant('withdraw' as const), amount }),
    fc.record({ op: fc.constant('withdrawDone' as const), succeeded: fc.boolean() }),
    fc.record({ op: fc.constant('replayDeposit' as const) }),
  );

  it('баланс совпадает с моделью, инварианты держатся', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const u = await newUser();
        const model = { main: 0n, hold: 0n, pending: 0n };
        const session = uuidv7();
        let lastIntent: { id: string; amount: bigint } | null = null;
        const pendingPayouts: { id: string; amount: bigint }[] = [];
        let holds = 0;

        for (const o of ops) {
          switch (o.op) {
            case 'deposit': {
              lastIntent = { id: uuidv7(), amount: o.amount };
              await wallet.creditDeposit({ userId: u, intentId: lastIntent.id, amount: o.amount });
              model.main += o.amount;
              break;
            }
            case 'replayDeposit':
              if (lastIntent)
                await wallet.creditDeposit({
                  userId: u,
                  intentId: lastIntent.id,
                  amount: lastIntent.amount,
                });
              break;
            case 'hold': {
              const p = wallet.hold({
                userId: u,
                currency: 'USDT',
                amount: o.amount,
                sessionId: `${session}-${holds++}`,
              });
              if (o.amount > model.main)
                await expect(p).rejects.toBeInstanceOf(InsufficientFundsError);
              else {
                await p;
                model.main -= o.amount;
                model.hold += o.amount;
              }
              break;
            }
            case 'release': {
              const { released } = await wallet.release({
                userId: u,
                currency: 'USDT',
                sessionId: uuidv7(),
              });
              expect(released).toBe(model.hold);
              model.main += model.hold;
              model.hold = 0n;
              break;
            }
            case 'withdraw': {
              const id = uuidv7();
              const p = wallet.requestWithdrawal({ userId: u, payoutId: id, amount: o.amount });
              if (o.amount > model.main)
                await expect(p).rejects.toBeInstanceOf(InsufficientFundsError);
              else {
                await p;
                model.main -= o.amount;
                model.pending += o.amount;
                pendingPayouts.push({ id, amount: o.amount });
              }
              break;
            }
            case 'withdrawDone': {
              const payout = pendingPayouts.shift();
              if (!payout) break;
              await wallet.completeWithdrawal({
                userId: u,
                payoutId: payout.id,
                amount: payout.amount,
                succeeded: o.succeeded,
              });
              model.pending -= payout.amount;
              if (!o.succeeded) model.main += payout.amount;
              break;
            }
          }
        }
        expect(await balance(u)).toEqual({
          main: model.main,
          hold: model.hold,
          pendingWithdrawal: model.pending,
        });
      }),
      { numRuns: 30 },
    );
    await assertInvariants();
  });
});
