import type { Currency, Minor } from '@winhappens/shared';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import { AppError } from '../errors.js';

export interface Leg {
  accountId: string;
  /** > 0 — зачисление, < 0 — списание. */
  amount: Minor;
}

export interface Posting {
  kind: string;
  ref?: { type: string; id: string };
  /** Повтор с тем же ключом не создаёт вторую транзакцию (вебхуки, ретраи). */
  idempotencyKey?: string;
  legs: Leg[];
}

export interface PostResult {
  txId: string;
  /** true — транзакция с этим ключом уже была, ничего не проведено. */
  replayed: boolean;
}

export class InsufficientFundsError extends AppError {
  constructor(readonly accountId: string) {
    super(409, 'insufficient_funds');
  }
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

/** Схлопывает ноги по счёту и проверяет, что транзакция сбалансирована. */
export function normalizeLegs(legs: Leg[]): Leg[] {
  const byAccount = new Map<string, Minor>();
  for (const l of legs) {
    if (l.amount === 0n) continue;
    byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0n) + l.amount);
  }
  const out = [...byAccount]
    .filter(([, a]) => a !== 0n)
    .map(([accountId, amount]) => ({ accountId, amount }));
  if (out.length === 0) throw new LedgerError('empty posting');
  if (out.reduce((s, l) => s + l.amount, 0n) !== 0n) throw new LedgerError('unbalanced posting');
  return out;
}

/**
 * Проводит транзакцию. Вызывается внутри транзакции БД (trx) — так проводку можно атомарно
 * совместить с изменением доменных таблиц. Счета блокируются в порядке id, чтобы конкурирующие
 * переводы не взаимоблокировались.
 */
export async function post(trx: Db, p: Posting): Promise<PostResult> {
  const legs = normalizeLegs(p.legs);
  const txId = uuidv7();

  const inserted = await trx
    .insertInto('ledger_tx')
    .values({
      id: txId,
      kind: p.kind,
      ref_type: p.ref?.type ?? null,
      ref_id: p.ref?.id ?? null,
      idempotency_key: p.idempotencyKey ?? null,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) {
    const existing = await trx
      .selectFrom('ledger_tx')
      .select('id')
      .where('idempotency_key', '=', p.idempotencyKey!)
      .executeTakeFirstOrThrow();
    return { txId: existing.id, replayed: true };
  }

  const accounts = await trx
    .selectFrom('wallet_account')
    .select(['id', 'balance', 'allow_negative', 'currency'])
    .where(
      'id',
      'in',
      legs.map((l) => l.accountId),
    )
    .orderBy('id')
    .forUpdate()
    .execute();
  if (accounts.length !== legs.length) throw new LedgerError('unknown account in posting');
  if (new Set(accounts.map((a) => a.currency)).size !== 1)
    throw new LedgerError('mixed currencies in posting');

  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const leg of legs) {
    const acc = byId.get(leg.accountId)!;
    const balance = acc.balance + leg.amount;
    if (balance < 0n && !acc.allow_negative) throw new InsufficientFundsError(acc.id);
    acc.balance = balance;
    await trx.updateTable('wallet_account').set({ balance }).where('id', '=', acc.id).execute();
    await trx
      .insertInto('ledger_entry')
      .values({ tx_id: txId, account_id: acc.id, amount: leg.amount, balance_after: balance })
      .execute();
  }
  return { txId, replayed: false };
}

export type { Currency };
