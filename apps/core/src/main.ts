import { loadCoreConfig } from '@winhappens/config';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createDb, migrateToLatest } from './db/index.js';
import { createIdentityModule, createWalletModule } from './wiring.js';

const config = loadCoreConfig();
const { db, pool } = createDb(config.env.CORE_DATABASE_URL);
const redis = new Redis(config.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
// Ошибки соединения отражаются в /health, процесс не падает.
redis.on('error', () => {});

await migrateToLatest(db);

const app = buildApp(
  {
    probes: {
      postgres: async () => void (await pool.query('select 1')),
      redis: async () => void (await redis.ping()),
    },
    identity: createIdentityModule(db, config, { log: (m) => app.log.info(m) }),
    wallet: createWalletModule(db, config),
  },
  { logger: { level: config.env.LOG_LEVEL } },
);

app.addHook('onClose', async () => {
  await Promise.allSettled([db.destroy(), redis.quit()]);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port: config.env.CORE_PORT, host: '0.0.0.0' });
