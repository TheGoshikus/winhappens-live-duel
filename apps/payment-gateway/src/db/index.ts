import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import pg from 'pg';
import * as m0001 from './migrations/0001_payments.js';
import type { PaymentsDatabase } from './schema.js';

export type Db = Kysely<PaymentsDatabase>;

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));

export function createDb(connectionString: string, max = 5) {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', () => {});
  return { db: new Kysely<PaymentsDatabase>({ dialect: new PostgresDialect({ pool }) }), pool };
}

const migrations: Record<string, Migration> = { '0001_payments': m0001 };

// Migrator принимает Kysely<any>: схема до миграций ещё не совпадает с PaymentsDatabase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>) {
  const { error } = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}
