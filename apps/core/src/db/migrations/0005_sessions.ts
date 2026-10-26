import { sql, type Kysely } from 'kysely';

/**
 * Сессия игрок ↔ крупье (roadmap этап 5): 300 с, депозит D = S × rounds_buffer у каждого.
 * hold_left — остаток депозита участника: на один счёт session_hold может приходиться
 * несколько параллельных сессий (игрок играет у разных крупье), поэтому учёт — по сессии.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table duel_session (
      id uuid primary key,
      dealer_id uuid not null references users(id),
      player_id uuid not null references users(id),
      currency text not null check (currency in ('USDT', 'FUN')),
      stake bigint not null check (stake > 0),
      deposit bigint not null check (deposit > 0),
      player_hold_left bigint not null check (player_hold_left >= 0),
      dealer_hold_left bigint not null check (dealer_hold_left >= 0),
      status text not null check (status in ('active', 'ended')),
      -- Причина завершения; задана при active — сессия закрывается, новых раундов нет.
      end_reason text,
      started_at timestamptz not null,
      ends_at timestamptz not null,
      ended_at timestamptz,
      player_offline_at timestamptz,
      dealer_offline_at timestamptz,
      check (dealer_id <> player_id)
    )
  `.execute(db);
  // Крупье в один момент играет с одним игроком; игрок может вести сессии у разных крупье.
  await sql`create unique index duel_session_active_dealer on duel_session (dealer_id) where status = 'active'`.execute(
    db,
  );
  await sql`create index duel_session_active_player on duel_session (player_id) where status = 'active'`.execute(
    db,
  );
  await sql`alter table duel_round add column session_id uuid references duel_session(id)`.execute(
    db,
  );
  await sql`create index duel_round_session_idx on duel_round (session_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table duel_round drop column session_id`.execute(db);
  await sql`drop table duel_session`.execute(db);
}
