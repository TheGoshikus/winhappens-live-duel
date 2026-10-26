import type { PaymentEvent } from '@winhappens/shared';
import { uuidv7 } from 'uuidv7';
import type { Eligibility, EligibilitySubject } from '../eligibility/index.js';
import { forbidden } from '../errors.js';
import type { WalletService } from '../wallet/service.js';
import { GatewayUnavailableError, type GatewayClient } from './gateway-client.js';

export interface PaymentsDeps {
  gateway: GatewayClient;
  wallet: WalletService;
  eligibility: Pick<Eligibility, 'canDeposit' | 'canWithdraw'>;
  subject: (userId: string, ipCountry: string | null) => Promise<EligibilitySubject>;
  /** Баланс изменился (WS wallet.updated). */
  onWallet?: (userId: string) => Promise<void>;
}

/** Пополнение и вывод USDT через шлюз; события шлюза → проводки ledger (payments.md §5). */
export function createPaymentsService({
  gateway,
  wallet,
  eligibility,
  subject,
  onWallet,
}: PaymentsDeps) {
  return {
    async deposit(
      userId: string,
      q: { amount: bigint; currency: 'USDT' | 'EUR'; rail: 'card' | 'crypto' },
      ipCountry: string | null,
      idempotencyKey: string,
    ) {
      const d = eligibility.canDeposit(await subject(userId, ipCountry));
      if (!d.ok) throw forbidden(d.reason);
      // Ключ привязан к пользователю: чужой ключ не вернёт чужой депозит.
      const session = await gateway.createDeposit({ userId, ...q }, `${userId}:${idempotencyKey}`);
      return { ...session, ledgerAmount: session.ledgerAmount.toString() };
    },

    /**
     * Вывод: деньги замораживаются (main → pending_withdrawal) до ответа шлюза. Если шлюз
     * недоступен, заявка остаётся в ожидании — повтор и сверка, а не возврат, иначе при
     * запоздалом успехе выплата задвоится.
     */
    async withdraw(
      userId: string,
      q: { amount: bigint; rail: 'card' | 'crypto'; destination: string },
    ) {
      const d = eligibility.canWithdraw(await subject(userId, null));
      if (!d.ok) throw forbidden(d.reason);
      const payoutId = uuidv7();
      await wallet.requestWithdrawal({ userId, payoutId, amount: q.amount });
      try {
        const r = await gateway.createPayout({ payoutId, userId, ...q });
        return { payoutId, status: r.status };
      } catch (e) {
        if (e instanceof GatewayUnavailableError) return { payoutId, status: 'pending' as const };
        // Шлюз отказал окончательно — деньги обратно на main.
        await wallet.completeWithdrawal({ userId, payoutId, amount: q.amount, succeeded: false });
        throw e;
      }
    },

    /** Событие шлюза (at-least-once): все проводки идемпотентны по intentId/payoutId. */
    async handleEvent(e: PaymentEvent) {
      switch (e.type) {
        case 'deposit.succeeded':
          await wallet.creditDeposit({
            userId: e.userId,
            intentId: e.intentId,
            amount: e.ledgerAmount,
          });
          break;
        case 'payout.succeeded':
        case 'payout.failed':
          await wallet.completeWithdrawal({
            userId: e.userId,
            payoutId: e.payoutId,
            amount: e.amount,
            succeeded: e.type === 'payout.succeeded',
          });
          break;
        case 'deposit.failed':
          return;
      }
      await onWallet?.(e.userId).catch(() => {});
    },
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
