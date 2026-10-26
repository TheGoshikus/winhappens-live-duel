import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | undefined, never>;
type Json = ColumnType<unknown, string, string>;

export type Rail = 'card' | 'crypto';
export type IntentStatus = 'created' | 'pending' | 'succeeded' | 'failed' | 'expired';
export type PayoutStatus = 'requested' | 'review' | 'approved' | 'sent' | 'succeeded' | 'failed';

export interface PaymentIntentTable {
  id: string;
  user_id: string;
  /** Сумма в валюте платежа (minor units этой валюты). */
  amount: bigint;
  currency: 'USDT' | 'EUR';
  /** Сколько зачислить в ledger core, USDT minor (10⁻⁶) — по зафиксированной котировке. */
  ledger_amount: bigint;
  fx_rate: string;
  provider: string;
  rail: Rail;
  status: IntentStatus;
  provider_ref: string | null;
  checkout_url: string | null;
  address: string | null;
  idempotency_key: string;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface PayoutTable {
  /** = payoutId из core (идемпотентность по первичному ключу). */
  id: string;
  user_id: string;
  amount: bigint;
  rail: Rail;
  destination: string;
  /** sha256(rail:destination) — для антифрода (общий метод у разных игроков). */
  fingerprint: string;
  status: PayoutStatus;
  review_reason: string | null;
  failure_reason: string | null;
  provider: string | null;
  provider_ref: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface ProviderTransactionTable {
  id: Generated<bigint>;
  kind: 'deposit' | 'payout';
  ref_id: string;
  provider: string;
  provider_ref: string;
  status: 'succeeded' | 'failed';
  created_at: CreatedAt;
}

export interface WebhookEventTable {
  id: Generated<bigint>;
  provider: string;
  event_id: string;
  payload: Json;
  result: string | null;
  received_at: CreatedAt;
}

export interface OutboxTable {
  id: string;
  type: string;
  payload: Json;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  delivered_at: Timestamp | null;
  last_error: string | null;
  created_at: CreatedAt;
}

export interface PaymentsDatabase {
  payment_intent: PaymentIntentTable;
  payout: PayoutTable;
  provider_transaction: ProviderTransactionTable;
  webhook_event: WebhookEventTable;
  outbox: OutboxTable;
}
