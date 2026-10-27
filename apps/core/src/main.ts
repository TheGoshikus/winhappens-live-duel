import { loadCoreConfig } from '@winhappens/config';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createDb, migrateToLatest } from './db/index.js';
import { createRedisBus } from './realtime/bus.js';
import { createNotifier } from './realtime/notifier.js';
import { createRedisPresence } from './realtime/presence.js';
import {
  createIdentityModule,
  createMatchModule,
  createPaymentsModule,
  createRoundModule,
  createVideoModule,
  createWalletModule,
} from './wiring.js';

const config = loadCoreConfig();
const { db, pool } = createDb(config.env.CORE_DATABASE_URL);
const redis = new Redis(config.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
// Подписка pub/sub требует отдельного соединения.
const redisSub = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: null });
// Ошибки соединения отражаются в /health, процесс не падает.
redis.on('error', () => {});
redisSub.on('error', () => {});

await migrateToLatest(db);

// Шина событий и присутствие — через Redis: несколько инстансов core видят одни сокеты.
const bus = createRedisBus(redis, redisSub);
const presence = createRedisPresence(redis);

const identity = createIdentityModule(db, config, { log: (m) => app.log.info(m) });
const wallet = createWalletModule(db, config);
const notifier = createNotifier(bus, wallet.wallet);
const rounds = createRoundModule(db, config, identity, wallet, {
  isOnline: (userId) => presence.isOnline(userId),
  emit: (ch, svc) => notifier.changes(ch, svc),
});
const matchmaking = createMatchModule(db, config, identity, wallet, rounds, {
  emit: (ch, svc) => notifier.matchChanges(ch, svc),
});
notifier.useMatchmaking(matchmaking.matchmaking);
const app = buildApp(
  {
    probes: {
      postgres: async () => void (await pool.query('select 1')),
      redis: async () => void (await redis.ping()),
    },
    identity,
    wallet,
    rounds,
    video: createVideoModule(db, config, identity, {
      busy: () => rounds.rounds.busyDealers(),
      onOffline: (userId) => rounds.rounds.endDealerSessions(userId),
      onTablesChanged: () => notifier.tablesChanged(),
    }),
    payments: createPaymentsModule(config, identity, wallet, fetch, (userId) =>
      notifier.wallet(userId),
    ),
    realtime: { bus, presence, tokens: identity.tokens },
    matchmaking,
  },
  { logger: { level: config.env.LOG_LEVEL } },
);

// Таймауты раундов, конец сессий и переподключение — даже если клиенты молчат (architecture §6.3).
const sweeper = setInterval(() => {
  void rounds.rounds.sweep().catch((e) => app.log.error(e));
  void matchmaking.matchmaking.sweep().catch((e) => app.log.error(e));
}, 1_000);

app.addHook('onClose', async () => {
  clearInterval(sweeper);
  await Promise.allSettled([db.destroy(), redis.quit(), redisSub.quit()]);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port: config.env.CORE_PORT, host: '0.0.0.0' });
