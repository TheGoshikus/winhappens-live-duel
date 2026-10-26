import { loadGatewayConfig } from '@winhappens/config';
import { MockAdapter } from './adapters/mock.js';
import { buildApp } from './app.js';
import { createDb, migrateToLatest } from './db/index.js';
import { createGateway } from './service.js';

const { env } = loadGatewayConfig();
const { db, pool } = createDb(env.PAYMENTS_DATABASE_URL);
await migrateToLatest(db);

const mock = new MockAdapter({
  publicUrl: env.PAYMENT_GATEWAY_PUBLIC_URL,
  secret: env.MOCK_PROVIDER_SECRET,
});
// Реальные провайдеры (фиат-эквайер, крипто-процессинг) подключаются здесь адаптерами.
const adapters = env.NODE_ENV === 'production' ? [] : [mock];
const gateway = createGateway(db, adapters, {
  payoutReviewThreshold: env.PAYOUT_REVIEW_THRESHOLD,
  fxEurUsdt: env.FX_EUR_USDT,
  coreEventsUrl: env.CORE_EVENTS_URL,
  secret: env.PAYMENT_GATEWAY_SECRET,
});

const app = buildApp(
  {
    probes: { postgres: async () => void (await pool.query('select 1')) },
    routes: {
      gateway,
      secret: env.PAYMENT_GATEWAY_SECRET,
      mock,
      autoSettleMockPayouts: env.NODE_ENV !== 'production',
    },
  },
  { logger: { level: env.LOG_LEVEL } },
);

// Доставка событий в core: at-least-once, повторы с паузой.
const outbox = setInterval(
  () => void gateway.deliverOutbox().catch((e) => app.log.error(e)),
  1_000,
);

app.addHook('onClose', async () => {
  clearInterval(outbox);
  await db.destroy();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port: env.PAYMENT_GATEWAY_PORT, host: '0.0.0.0' });
