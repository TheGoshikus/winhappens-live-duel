import { loadCoreConfig } from '@winhappens/config';
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from './app.js';

const config = loadCoreConfig();
const db = new pg.Pool({ connectionString: config.env.CORE_DATABASE_URL, max: 10 });
const redis = new Redis(config.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
// Ошибки соединения отражаются в /health, процесс не падает.
db.on('error', () => {});
redis.on('error', () => {});

const app = buildApp(
  {
    probes: {
      postgres: async () => void (await db.query('select 1')),
      redis: async () => void (await redis.ping()),
    },
  },
  { logger: { level: config.env.LOG_LEVEL } },
);

app.addHook('onClose', async () => {
  await Promise.allSettled([db.end(), redis.quit()]);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port: config.env.CORE_PORT, host: '0.0.0.0' });
