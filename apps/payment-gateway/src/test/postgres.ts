import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, migrateToLatest, type Db } from '../db/index.js';

/** Чистый Postgres для БД шлюза с применёнными миграциями. */
export async function startTestDb(): Promise<{ db: Db; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const { db } = createDb(container.getConnectionUri());
  await migrateToLatest(db);
  return {
    db,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
