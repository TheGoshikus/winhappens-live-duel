import type { PaymentEventWire } from '@winhappens/shared';
import { signBody } from '@winhappens/shared/server';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { PaymentProviderAdapter, RawWebhook, RouteQuery } from './adapters/types.js';
import type { Db } from './db/index.js';
import type { Rail } from './db/schema.js';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface GatewaySettings {
  payoutReviewThreshold: bigint;
  /** Котировка EUR → USDT как десятичная строка ("1.08"). */
  fxEurUsdt: string;
  coreEventsUrl: string;
  secret: string;
}

/** "1.08" → 1_080_000 (6 знаков, как USDT). */
function rateMicros(rate: string): bigint {
  const [i, f = ''] = rate.split('.');
  return BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6));
}

/** Сумма к зачислению в ledger (USDT minor 10⁻⁶) по зафиксированной котировке. */
export function ledgerAmountOf(
  amount: bigint,
  currency: 'USDT' | 'EUR',
  fxEurUsdt: string,
): { ledger: bigint; rate: string } {
  if (currency === 'USDT') return { ledger: amount, rate: '1' };
  // EUR minor = 10⁻²: amount × rate × 10⁴, rate в микро-единицах → / 10².
  return { ledger: (amount * rateMicros(fxEurUsdt)) / 100n, rate: fxEurUsdt };
}

export function createGateway(
  db: Db,
  adapters: PaymentProviderAdapter[],
  settings: GatewaySettings,
  clock = () => new Date(),
) {
  const byId = new Map(adapters.map((a) => [a.id, a]));

  /** Маршрутизация: первый провайдер, который поддерживает рельс/валюту/сумму (каскад — после MVP). */
  function route(q: RouteQuery): PaymentProviderAdapter {
    const a = adapters.find((x) => x.rails.includes(q.rail) && x.supports(q));
    if (!a) throw new GatewayError(422, 'no_provider_for_route');
    return a;
  }

  const enqueue = (trx: Db, e: PaymentEventWire) =>
    trx
      .insertInto('outbox')
      .values({ id: e.id, type: e.type, payload: JSON.stringify(e), next_attempt_at: clock() })
      .execute();

  async function sendPayout(trx: Db, id: string) {
    const p = await trx
      .selectFrom('payout')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const provider = route({ rail: p.rail, currency: 'USDT', amount: p.amount });
    const { providerRef } = await provider.createPayout({
      payoutId: p.id,
      amount: p.amount,
      rail: p.rail,
      destination: p.destination,
    });
    await trx
      .updateTable('payout')
      .set({
        status: 'sent',
        provider: provider.id,
        provider_ref: providerRef,
        updated_at: clock(),
      })
      .where('id', '=', id)
      .execute();
  }

  async function failPayout(trx: Db, id: string, reason: string) {
    const p = await trx
      .updateTable('payout')
      .set({ status: 'failed', failure_reason: reason, updated_at: clock() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await enqueue(trx, {
      id: uuidv7(),
      type: 'payout.failed',
      payoutId: p.id,
      userId: p.user_id,
      amount: p.amount.toString(),
      reason,
    });
  }

  const intentView = (i: {
    id: string;
    status: string;
    ledger_amount: bigint;
    checkout_url: string | null;
    address: string | null;
  }) => ({
    intentId: i.id,
    status: i.status,
    ledgerAmount: i.ledger_amount.toString(),
    checkoutUrl: i.checkout_url,
    address: i.address,
  });

  return {
    /** Депозит: идемпотентно по ключу; котировка фиксируется на момент создания. */
    async createDeposit(
      q: { userId: string; amount: bigint; currency: 'USDT' | 'EUR'; rail: Rail },
      idempotencyKey: string,
    ) {
      const existing = await db
        .selectFrom('payment_intent')
        .selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing) return intentView(existing);
      const provider = route({ rail: q.rail, currency: q.currency, amount: q.amount });
      const { ledger, rate } = ledgerAmountOf(q.amount, q.currency, settings.fxEurUsdt);
      const id = uuidv7();
      const session = await provider.createDeposit({
        intentId: id,
        amount: q.amount,
        currency: q.currency,
        rail: q.rail,
      });
      const row = await db
        .insertInto('payment_intent')
        .values({
          id,
          user_id: q.userId,
          amount: q.amount,
          currency: q.currency,
          ledger_amount: ledger,
          fx_rate: rate,
          provider: provider.id,
          rail: q.rail,
          status: 'pending',
          provider_ref: session.providerRef,
          checkout_url: session.checkoutUrl,
          address: session.address,
          idempotency_key: idempotencyKey,
          updated_at: clock(),
        })
        .onConflict((oc) => oc.column('idempotency_key').doNothing())
        .returningAll()
        .executeTakeFirst();
      // Гонка двух одинаковых запросов: возвращаем тот, что записался первым.
      return intentView(
        row ??
          (await db
            .selectFrom('payment_intent')
            .selectAll()
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirstOrThrow()),
      );
    },

    async getDeposit(id: string) {
      const i = await db
        .selectFrom('payment_intent')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!i) throw new GatewayError(404, 'intent_not_found');
      return intentView(i);
    },

    /**
     * Выплата: идемпотентно по payoutId из core. Выше порога — на ручную проверку,
     * иначе сразу провайдеру.
     */
    async createPayout(q: {
      payoutId: string;
      userId: string;
      amount: bigint;
      rail: Rail;
      destination: string;
    }) {
      return db.transaction().execute(async (trx) => {
        const review = q.amount > settings.payoutReviewThreshold;
        const inserted = await trx
          .insertInto('payout')
          .values({
            id: q.payoutId,
            user_id: q.userId,
            amount: q.amount,
            rail: q.rail,
            destination: q.destination,
            fingerprint: createHash('sha256').update(`${q.rail}:${q.destination}`).digest('hex'),
            status: review ? 'review' : 'approved',
            review_reason: review ? 'amount_above_threshold' : null,
            failure_reason: null,
            provider: null,
            provider_ref: null,
            updated_at: clock(),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted && !review) await sendPayout(trx, q.payoutId);
        const p = await trx
          .selectFrom('payout')
          .select(['id', 'status'])
          .where('id', '=', q.payoutId)
          .executeTakeFirstOrThrow();
        return { payoutId: p.id, status: p.status };
      });
    },

    /** Ручная проверка (админка, этап 11): одобрить → отправить провайдеру; отклонить → вернуть деньги. */
    async reviewPayout(
      id: string,
      decision: { approve: true } | { approve: false; reason: string },
    ) {
      return db.transaction().execute(async (trx) => {
        const p = await trx
          .selectFrom('payout')
          .select(['status'])
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!p) throw new GatewayError(404, 'payout_not_found');
        if (p.status !== 'review') throw new GatewayError(409, 'payout_not_in_review');
        if (decision.approve) {
          await trx
            .updateTable('payout')
            .set({ status: 'approved', updated_at: clock() })
            .where('id', '=', id)
            .execute();
          await sendPayout(trx, id);
        } else {
          await failPayout(trx, id, decision.reason);
        }
        return trx
          .selectFrom('payout')
          .select(['id as payoutId', 'status'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      });
    },

    /**
     * Вебхук провайдера: подпись → сырой лог с дедупом (provider, event_id) → переход статуса →
     * outbox. Всё в одной транзакции: событие для core появляется ровно один раз.
     */
    async handleWebhook(
      providerId: string,
      raw: RawWebhook,
    ): Promise<'applied' | 'duplicate' | 'ignored'> {
      const provider = byId.get(providerId);
      if (!provider) throw new GatewayError(404, 'unknown_provider');
      const e = await provider.parseWebhook(raw);
      return db.transaction().execute(async (trx) => {
        const logged = await trx
          .insertInto('webhook_event')
          .values({ provider: providerId, event_id: e.eventId, payload: raw.body })
          .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!logged) return 'duplicate';

        let result: 'applied' | 'ignored' = 'ignored';
        if (e.kind === 'deposit') {
          const i = await trx
            .selectFrom('payment_intent')
            .selectAll()
            .where('provider_ref', '=', e.providerRef)
            .forUpdate()
            .executeTakeFirst();
          if (i && i.status === 'pending') {
            await trx
              .updateTable('payment_intent')
              .set({ status: e.status, updated_at: clock() })
              .where('id', '=', i.id)
              .execute();
            await enqueue(
              trx,
              e.status === 'succeeded'
                ? {
                    id: uuidv7(),
                    type: 'deposit.succeeded',
                    intentId: i.id,
                    userId: i.user_id,
                    ledgerAmount: i.ledger_amount.toString(),
                  }
                : { id: uuidv7(), type: 'deposit.failed', intentId: i.id, userId: i.user_id },
            );
            await trx
              .insertInto('provider_transaction')
              .values({
                kind: 'deposit',
                ref_id: i.id,
                provider: providerId,
                provider_ref: e.providerRef,
                status: e.status,
              })
              .execute();
            result = 'applied';
          }
        } else {
          const p = await trx
            .selectFrom('payout')
            .selectAll()
            .where('provider_ref', '=', e.providerRef)
            .forUpdate()
            .executeTakeFirst();
          if (p && p.status === 'sent') {
            if (e.status === 'succeeded') {
              await trx
                .updateTable('payout')
                .set({ status: 'succeeded', updated_at: clock() })
                .where('id', '=', p.id)
                .execute();
              await enqueue(trx, {
                id: uuidv7(),
                type: 'payout.succeeded',
                payoutId: p.id,
                userId: p.user_id,
                amount: p.amount.toString(),
              });
            } else {
              await failPayout(trx, p.id, e.reason ?? 'provider_failed');
            }
            await trx
              .insertInto('provider_transaction')
              .values({
                kind: 'payout',
                ref_id: p.id,
                provider: providerId,
                provider_ref: e.providerRef,
                status: e.status,
              })
              .execute();
            result = 'applied';
          }
        }
        await trx
          .updateTable('webhook_event')
          .set({ result })
          .where('id', '=', logged.id)
          .execute();
        return result;
      });
    },

    /**
     * Доставка outbox в core (at-least-once): подписанный POST; при ошибке — повтор с
     * экспоненциальной паузой до 60 с. core обязан быть идемпотентным (ключи ledger).
     */
    async deliverOutbox(fetchImpl: typeof fetch = fetch, limit = 20): Promise<number> {
      return db.transaction().execute(async (trx) => {
        const batch = await trx
          .selectFrom('outbox')
          .selectAll()
          .where('delivered_at', 'is', null)
          .where('next_attempt_at', '<=', clock())
          .orderBy('created_at')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        let delivered = 0;
        for (const m of batch) {
          const body = JSON.stringify(m.payload);
          let error: string | null = null;
          try {
            const res = await fetchImpl(settings.coreEventsUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-wh-signature': signBody(settings.secret, body),
              },
              body,
            });
            if (!res.ok) error = `HTTP ${res.status}`;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          if (error === null) {
            delivered++;
            await trx
              .updateTable('outbox')
              .set({ delivered_at: clock(), last_error: null })
              .where('id', '=', m.id)
              .execute();
          } else {
            const delaySec = Math.min(60, 2 ** m.attempts);
            await trx
              .updateTable('outbox')
              .set({
                attempts: sql`attempts + 1`,
                last_error: error,
                next_attempt_at: new Date(clock().getTime() + delaySec * 1000),
              })
              .where('id', '=', m.id)
              .execute();
          }
        }
        return delivered;
      });
    },

    /** Для страницы mock-оплаты: найти депозит по ссылке провайдера. */
    async intentByRef(providerRef: string) {
      return db
        .selectFrom('payment_intent')
        .selectAll()
        .where('provider_ref', '=', providerRef)
        .executeTakeFirst();
    },

    newEventId: () => randomUUID(),
  };
}

export type Gateway = ReturnType<typeof createGateway>;
