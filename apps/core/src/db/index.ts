import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import pg from 'pg';
import * as m0001 from './migrations/0001_identity.js';
import type { Database } from './schema.js';

export type { Database } from './schema.js';
export type Db = Kysely<Database>;

// bigint из Postgres (int8) читаем как BigInt, а не строку: деньги — только bigint.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));
// date оставляем строкой YYYY-MM-DD, без сдвига часового пояса.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(connectionString: string, max = 10) {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', () => {});
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

/** Миграции перечислены явно, чтобы они попадали в бандл tsup. */
const migrations: Record<string, Migration> = {
  '0001_identity': m0001,
};

// Migrator принимает Kysely<any>: схема до миграций ещё не совпадает с Database.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>) {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return results ?? [];
}
