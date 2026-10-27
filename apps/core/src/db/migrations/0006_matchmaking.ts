import { sql, type Kysely } from 'kysely';

/**
 * Матчмейкинг и смена (roadmap этап 6). Заявка игрока: прямая (выбрал крупье) или случайная
 * (очередь по ключу валюта/ставка/18+/пол). Крупье принимает за matchAcceptSec.
 * Смена — 15 с после конца сессии: дальше / остаться ×2 / противоположный пол / выйти.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table dealer_profile add column auto_accept boolean not null default true`.execute(
    db,
  );
  await sql`alter table duel_session add column stay_streak integer not null default 0`.execute(db);

  await sql`
    create table match_ticket (
      id uuid primary key,
      player_id uuid not null references users(id),
      mode text not null check (mode in ('direct', 'random')),
      currency text not null check (currency in ('USDT', 'FUN')),
      stake bigint not null check (stake > 0),
      gender_pref text not null check (gender_pref in ('any', 'opposite')),
      adult boolean not null default false,
      player_ip_country char(2),
      -- Кому предложен матч (прямая заявка — сразу; случайная — когда нашлась свободная крупье).
      dealer_id uuid references users(id),
      status text not null check (status in ('waiting', 'offered', 'accepted', 'cancelled', 'expired')),
      reason text,
      offer_deadline timestamptz,
      -- Отказавшие или не ответившие крупье: в эту заявку больше не предлагаются.
      excluded uuid[] not null default '{}',
      stay_streak integer not null default 0,
      session_id uuid references duel_session(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create unique index match_ticket_active_player on match_ticket (player_id) where status in ('waiting', 'offered')`.execute(
    db,
  );
  await sql`create unique index match_ticket_offered_dealer on match_ticket (dealer_id) where status = 'offered'`.execute(
    db,
  );
  await sql`create index match_ticket_waiting_idx on match_ticket (created_at) where status = 'waiting'`.execute(
    db,
  );

  await sql`
    create table shift (
      id uuid primary key,
      session_id uuid not null unique references duel_session(id),
      dealer_id uuid not null references users(id),
      player_id uuid not null references users(id),
      currency text not null check (currency in ('USDT', 'FUN')),
      stake bigint not null,
      stay_streak integer not null,
      deadline timestamptz not null,
      paused boolean not null default false,
      player_choice text check (player_choice in ('next', 'stay', 'opposite', 'exit')),
      dealer_choice text check (dealer_choice in ('stay', 'next')),
      status text not null check (status in ('open', 'resolved')),
      outcome text,
      next_session_id uuid references duel_session(id),
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index shift_open_idx on shift (deadline) where status = 'open'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table shift, match_ticket`.execute(db);
  await sql`alter table duel_session drop column stay_streak`.execute(db);
  await sql`alter table dealer_profile drop column auto_accept`.execute(db);
}
