import { sql, type Kysely } from 'kysely';

/**
 * Раунды дуэли игрок (место 0, ЧЁТ) ↔ крупье (место 1, НЕЧЁТ) с commit–reveal (architecture §6.1–6.2).
 * Завершённый раунд (settled/cancelled) — запись журнала: менять её нельзя.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table duel_round (
      id uuid primary key,
      dealer_id uuid not null references users(id),
      player_id uuid not null references users(id),
      currency text not null check (currency in ('USDT', 'FUN')),
      stake bigint not null check (stake > 0),
      item text check (item in ('glasses', 'hat', 'scarf', 'earrings', 'gloves', 'shoes', 'jacket')),
      status text not null check (status in ('commit', 'reveal', 'settled', 'cancelled')),
      player_commit text,
      dealer_commit text,
      player_number smallint check (player_number between 0 and 9),
      player_salt text,
      dealer_number smallint check (dealer_number between 0 and 9),
      dealer_salt text,
      commit_deadline timestamptz not null,
      reveal_deadline timestamptz,
      outcome text check (outcome in ('normal', 'forfeit')),
      winner_seat smallint check (winner_seat in (0, 1)),
      prize bigint,
      win_fee bigint,
      stake_fee bigint,
      signature text,
      created_at timestamptz not null default now(),
      settled_at timestamptz,
      check (dealer_id <> player_id)
    )
  `.execute(db);
  // Один открытый раунд на пару игрок–крупье.
  await sql`create unique index duel_round_open_pair on duel_round (dealer_id, player_id) where status in ('commit', 'reveal')`.execute(
    db,
  );
  await sql`create index duel_round_dealer_idx on duel_round (dealer_id, created_at desc)`.execute(
    db,
  );
  await sql`create index duel_round_player_idx on duel_round (player_id, created_at desc)`.execute(
    db,
  );
  await sql`create index duel_round_due_idx on duel_round (status, commit_deadline, reveal_deadline) where status in ('commit', 'reveal')`.execute(
    db,
  );

  await sql`
    create function duel_round_journal() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' or old.status in ('settled', 'cancelled') then
        raise exception 'duel_round % is final', old.id using errcode = '42501';
      end if;
      return new;
    end $$
  `.execute(db);
  await sql`create trigger duel_round_journal before update or delete on duel_round
    for each row execute function duel_round_journal()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table duel_round`.execute(db);
  await sql`drop function duel_round_journal`.execute(db);
}
