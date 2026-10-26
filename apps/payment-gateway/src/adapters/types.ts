import type { Rail } from '../db/schema.js';

/** Интерфейс адаптера провайдера (payments.md §3). core о провайдерах не знает. */
export interface RouteQuery {
  rail: Rail;
  currency: 'USDT' | 'EUR';
  amount: bigint;
}

export interface DepositSession {
  providerRef: string;
  /** Hosted checkout / iframe (фиат) */
  checkoutUrl: string | null;
  /** Одноразовый адрес (крипта) */
  address: string | null;
}

export interface ProviderEvent {
  eventId: string;
  kind: 'deposit' | 'payout';
  providerRef: string;
  status: 'succeeded' | 'failed';
  reason?: string;
}

export interface RawWebhook {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentProviderAdapter {
  readonly id: string;
  readonly rails: readonly Rail[];
  supports(q: RouteQuery): boolean;
  createDeposit(i: {
    intentId: string;
    amount: bigint;
    currency: 'USDT' | 'EUR';
    rail: Rail;
  }): Promise<DepositSession>;
  createPayout(p: {
    payoutId: string;
    amount: bigint;
    rail: Rail;
    destination: string;
  }): Promise<{ providerRef: string }>;
  /** Проверка подписи внутри: при ошибке — исключение. */
  parseWebhook(raw: RawWebhook): Promise<ProviderEvent>;
  fetchStatus(providerRef: string): Promise<'pending' | 'succeeded' | 'failed'>;
}

export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
}
