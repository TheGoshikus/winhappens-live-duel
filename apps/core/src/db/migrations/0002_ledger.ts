import { sql, type Kysely } from 'kysely';

/**
 * Ledger с двойной записью (architecture §0, §3, §5). Инварианты держит сама БД:
 * - сумма проводок одной транзакции = 0 и все проводки в одной валюте (отложенный триггер);
 * - баланс счёта ≥ 0, если счёту не разрешён минус (CHECK);
 * - ledger_tx и ledger_entry только дописываются.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table wallet_account (
      id uuid primary key,
      user_id uuid references users(id) on delete restrict,
      type text not null check (type in (
        'main', 'session_hold', 'pending_withdrawal',
        'round_pot', 'house_rake', 'gateway_clearing', 'fun_issuance'
      )),
      currency text not null check (currency in ('USDT', 'FUN')),
      allow_negative boolean not null default false,
      balance bigint not null default 0,
      created_at timestamptz not null default now(),
      constraint wallet_account_balance_check check (allow_negative or balance >= 0),
      -- Пользовательские счета принадлежат пользователю, системные — нет.
      constraint wallet_account_owner_check check (
        (type in ('main', 'session_hold', 'pending_withdrawal')) = (user_id is not null)
      )
    )
  `.execute(db);
  await sql`create unique index wallet_account_user_key on wallet_account (user_id, type, currency) where user_id is not null`.execute(
    db,
  );
  await sql`create unique index wallet_account_system_key on wallet_account (type, currency) where user_id is null`.execute(
    db,
  );

  await sql`
    create table ledger_tx (
      id uuid primary key,
      kind text not null,
      ref_type text,
      ref_id text,
      idempotency_key text unique,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index ledger_tx_ref_idx on ledger_tx (ref_type, ref_id)`.execute(db);

  await sql`
    create table ledger_entry (
      id bigint generated always as identity primary key,
      tx_id uuid not null references ledger_tx(id),
      account_id uuid not null references wallet_account(id),
      amount bigint not null check (amount <> 0),
      balance_after bigint not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index ledger_entry_account_idx on ledger_entry (account_id, id)`.execute(db);
  await sql`create index ledger_entry_tx_idx on ledger_entry (tx_id)`.execute(db);

  await sql`
    create function ledger_check_tx() returns trigger language plpgsql as $$
    declare
      total numeric;
      currencies int;
    begin
      select coalesce(sum(e.amount), 0), count(distinct a.currency)
        into total, currencies
        from ledger_entry e join wallet_account a on a.id = e.account_id
       where e.tx_id = new.tx_id;
      if total <> 0 then
        raise exception 'ledger tx % is unbalanced: sum = %', new.tx_id, total using errcode = '23514';
      end if;
      if currencies > 1 then
        raise exception 'ledger tx % mixes currencies', new.tx_id using errcode = '23514';
      end if;
      return null;
    end $$
  `.execute(db);
  await sql`
    create constraint trigger ledger_entry_balanced
      after insert on ledger_entry
      deferrable initially deferred
      for each row execute function ledger_check_tx()
  `.execute(db);

  await sql`
    create function ledger_append_only() returns trigger language plpgsql as $$
    begin
      raise exception '% is append-only', tg_table_name using errcode = '42501';
    end $$
  `.execute(db);
  for (const t of ['ledger_tx', 'ledger_entry']) {
    await sql`create trigger ${sql.raw(t)}_append_only before update or delete on ${sql.raw(t)}
      for each row execute function ledger_append_only()`.execute(db);
  }

  // Системные счета. Минус разрешён тем, через которые деньги/фантики входят в систему.
  await sql`
    insert into wallet_account (id, user_id, type, currency, allow_negative) values
      (gen_random_uuid(), null, 'gateway_clearing', 'USDT', true),
      (gen_random_uuid(), null, 'round_pot',        'USDT', false),
      (gen_random_uuid(), null, 'house_rake',       'USDT', false),
      (gen_random_uuid(), null, 'fun_issuance',     'FUN',  true),
      (gen_random_uuid(), null, 'round_pot',        'FUN',  false),
      (gen_random_uuid(), null, 'house_rake',       'FUN',  false)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table ledger_entry, ledger_tx, wallet_account`.execute(db);
  await sql`drop function ledger_check_tx, ledger_append_only`.execute(db);
}
