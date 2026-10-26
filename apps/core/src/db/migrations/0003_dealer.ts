import { sql, type Kysely } from 'kysely';

/** Профиль крупье: стол, сцена, минимальная ставка, статус эфира (LiveKit-комната). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table dealer_profile (
      user_id uuid primary key references users(id) on delete cascade,
      display_name text not null check (length(display_name) between 1 and 40),
      scene text not null check (scene in ('cabaret', 'lobby', 'nature', 'armchair')),
      currency text not null check (currency in ('USDT', 'FUN')),
      min_stake bigint not null check (min_stake > 0),
      status text not null default 'offline' check (status in ('offline', 'live')),
      room text not null unique,
      went_live_at timestamptz,
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dealer_profile_live_idx on dealer_profile (went_live_at) where status = 'live'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table dealer_profile`.execute(db);
}
