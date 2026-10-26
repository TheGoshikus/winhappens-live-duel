import { z } from 'zod';
import { gameConfigFromEnv, gameConfigSchema } from './game.js';
import { identityEnvSchema } from './identity.js';

export * from './game.js';
export * from './identity.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const port = z.coerce.number().int().min(1).max(65_535);
const url = z.string().url();
const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

export const coreEnvSchema = identityEnvSchema.extend({
  ...common,
  CORE_PORT: port.default(3000),
  CORE_DATABASE_URL: url,
  REDIS_URL: url,
  LIVEKIT_URL: url,
  /** Адрес LiveKit для браузеров; по умолчанию = LIVEKIT_URL. */
  LIVEKIT_PUBLIC_URL: url.optional(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  PAYMENT_GATEWAY_URL: url,
  PAYMENT_GATEWAY_SECRET: z.string().min(32),
  /** Seed ключа Ed25519 (32 байта, base64) для подписи результатов раундов. */
  ROUND_SIGNING_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'expected 32-byte base64 Ed25519 seed'),
});

const sharedSecret = z.string().min(32);

export const gatewayEnvSchema = z.object({
  ...common,
  PAYMENT_GATEWAY_PORT: port.default(3100),
  PAYMENTS_DATABASE_URL: url,
  /** Адрес шлюза для браузера (ссылки на hosted checkout mock-провайдера). */
  PAYMENT_GATEWAY_PUBLIC_URL: url.default('http://localhost:3100'),
  /** Общий секрет core ↔ gateway: подпись запросов и событий (HMAC). */
  PAYMENT_GATEWAY_SECRET: sharedSecret,
  /** Куда шлюз доставляет события outbox. */
  CORE_EVENTS_URL: url.default('http://localhost:3000/internal/payments/events'),
  /** Секрет подписи вебхуков mock-провайдера. */
  MOCK_PROVIDER_SECRET: z.string().min(16),
  /** Выплаты выше порога (USDT minor) идут на ручную проверку (payments.md §6). */
  PAYOUT_REVIEW_THRESHOLD: z.coerce.bigint().positive().default(100_000_000n),
  /** Котировка EUR → USDT для депозитов в евро (mock; в проде — от провайдера). */
  FX_EUR_USDT: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('1.08'),
});

function parseOrThrow<T extends z.ZodTypeAny>(name: string, schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid ${name} config:\n${issues}`);
  }
  return r.data;
}

type Env = Record<string, string | undefined>;

export function loadCoreConfig(env: Env = process.env) {
  return {
    env: parseOrThrow('core env', coreEnvSchema, env),
    game: parseOrThrow('game', gameConfigSchema, gameConfigFromEnv(env)),
  };
}
export type CoreConfig = ReturnType<typeof loadCoreConfig>;

export function loadGatewayConfig(env: Env = process.env) {
  return { env: parseOrThrow('payment-gateway env', gatewayEnvSchema, env) };
}
export type GatewayConfig = ReturnType<typeof loadGatewayConfig>;
