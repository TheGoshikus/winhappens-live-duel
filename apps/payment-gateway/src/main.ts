import { loadGatewayConfig } from '@winhappens/config';
import pg from 'pg';
import { buildApp } from './app.js';

const config = loadGatewayConfig();
const db = new pg.Pool({ connectionString: config.env.PAYMENTS_DATABASE_URL, max: 5 });
db.on('error', () => {});

const app = buildApp(
  { probes: { postgres: async () => void (await db.query('select 1')) } },
  { logger: { level: config.env.LOG_LEVEL } },
);

app.addHook('onClose', async () => {
  await db.end();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port: config.env.PAYMENT_GATEWAY_PORT, host: '0.0.0.0' });
