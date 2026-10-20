import { sql, type Kysely } from 'kysely';

const enumCheck = (col: string, values: string[]) =>
  sql.raw(`check (${col} in (${values.map((v) => `'${v}'`).join(', ')}))`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) =>
      c.notNull().modifyEnd(enumCheck('kind', ['guest', 'registered'])),
    )
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('active')
        .modifyEnd(enumCheck('status', ['active', 'blocked'])),
    )
    .addColumn('nickname', 'text')
    .addColumn('ip_country', 'char(2)')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('user_contact')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull().modifyEnd(enumCheck('kind', ['phone', 'email'])))
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('verified_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('user_contact_kind_value_key', ['kind', 'value'])
    .execute();
  await db.schema
    .createIndex('user_contact_user_id_idx')
    .on('user_contact')
    .column('user_id')
    .execute();

  await db.schema
    .createTable('otp_challenge')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('requested_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('channel', 'text', (c) =>
      c.notNull().modifyEnd(enumCheck('channel', ['phone', 'email'])),
    )
    .addColumn('destination', 'text', (c) => c.notNull())
    .addColumn('code_hash', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('otp_challenge_destination_idx')
    .on('otp_challenge')
    .columns(['channel', 'destination', 'created_at'])
    .execute();

  await db.schema
    .createTable('refresh_token')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('family_id', 'uuid', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('refresh_token_family_idx')
    .on('refresh_token')
    .column('family_id')
    .execute();

  await db.schema
    .createTable('kyc_verification')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) =>
      c.notNull().modifyEnd(enumCheck('status', ['pending', 'verified', 'rejected'])),
    )
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('provider_ref', 'text', (c) => c.notNull())
    .addColumn('birthdate', 'date')
    .addColumn('verified_gender', 'text', (c) =>
      c.modifyEnd(enumCheck('verified_gender', ['male', 'female'])),
    )
    .addColumn('country', 'char(2)')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('player_settings')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('adult_opt_in', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('daily_loss_limit', 'bigint', (c) => c.check(sql`daily_loss_limit >= 0`))
    .addColumn('self_excluded_until', 'timestamptz')
    .execute();

  await db.schema
    .createTable('user_block')
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('blocked_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('user_block_pkey', ['user_id', 'blocked_user_id'])
    .addCheckConstraint('user_block_not_self', sql`user_id <> blocked_user_id`)
    .execute();
  await db.schema
    .createIndex('user_block_blocked_idx')
    .on('user_block')
    .column('blocked_user_id')
    .execute();

  await db.schema
    .createTable('device_link')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) =>
      c.notNull().modifyEnd(enumCheck('kind', ['device', 'ip', 'payment'])),
    )
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('first_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('device_link_user_kind_fp_key', ['user_id', 'kind', 'fingerprint'])
    .execute();
  // Поиск сговора: кто ещё использовал тот же отпечаток (ТЗ §13).
  await db.schema
    .createIndex('device_link_fp_idx')
    .on('device_link')
    .columns(['kind', 'fingerprint'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'device_link',
    'user_block',
    'player_settings',
    'kyc_verification',
    'refresh_token',
    'otp_challenge',
    'user_contact',
    'users',
  ]) {
    await db.schema.dropTable(t).execute();
  }
}
