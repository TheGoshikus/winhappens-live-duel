import { sql, type Kysely } from 'kysely';

/** БД шлюза (payments.md §4). Деньги — bigint minor units. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table payment_intent (
      id uuid primary key,
      user_id uuid not null,
      amount bigint not null check (amount > 0),
      currency text not null check (currency in ('USDT', 'EUR')),
      ledger_amount bigint not null check (ledger_amount > 0),
      fx_rate text not null,
      provider text not null,
      rail text not null check (rail in ('card', 'crypto')),
      status text not null check (status in ('created', 'pending', 'succeeded', 'failed', 'expired')),
      provider_ref text unique,
      checkout_url text,
      address text,
      idempotency_key text not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index payment_intent_user_idx on payment_intent (user_id, created_at desc)`.execute(
    db,
  );

  await sql`
    create table payout (
      id uuid primary key,
      user_id uuid not null,
      amount bigint not null check (amount > 0),
      rail text not null check (rail in ('card', 'crypto')),
      destination text not null,
      fingerprint text not null,
      status text not null check (status in ('requested', 'review', 'approved', 'sent', 'succeeded', 'failed')),
      review_reason text,
      failure_reason text,
      provider text,
      provider_ref text unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index payout_fingerprint_idx on payout (fingerprint)`.execute(db);
  await sql`create index payout_review_idx on payout (created_at) where status = 'review'`.execute(
    db,
  );

  await sql`
    create table provider_transaction (
      id bigint generated always as identity primary key,
      kind text not null check (kind in ('deposit', 'payout')),
      ref_id uuid not null,
      provider text not null,
      provider_ref text not null,
      status text not null check (status in ('succeeded', 'failed')),
      created_at timestamptz not null default now()
    )
  `.execute(db);

  // Сырой вебхук + дедуп по (provider, event_id) — повторная доставка не применяется дважды.
  await sql`
    create table webhook_event (
      id bigint generated always as identity primary key,
      provider text not null,
      event_id text not null,
      payload jsonb not null,
      result text,
      received_at timestamptz not null default now(),
      unique (provider, event_id)
    )
  `.execute(db);

  // Outbox: события для core, доставка at-least-once с повторами.
  await sql`
    create table outbox (
      id uuid primary key,
      type text not null,
      payload jsonb not null,
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      delivered_at timestamptz,
      last_error text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index outbox_pending_idx on outbox (next_attempt_at) where delivered_at is null`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table outbox, webhook_event, provider_transaction, payout, payment_intent`.execute(
    db,
  );
}
