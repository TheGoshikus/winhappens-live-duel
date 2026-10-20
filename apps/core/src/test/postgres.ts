import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, migrateToLatest, type Db } from '../db/index.js';

/** Чистый Postgres с применёнными миграциями. */
export async function startTestDb(): Promise<{ db: Db; stop: () => Promise<void> }> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const { db } = createDb(container.getConnectionUri(), 5);
  await migrateToLatest(db);
  return {
    db,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
