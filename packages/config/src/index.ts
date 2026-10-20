import { z } from 'zod';
import { gameConfigFromEnv, gameConfigSchema } from './game.js';

export * from './game.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const port = z.coerce.number().int().min(1).max(65_535);
const url = z.string().url();
const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

export const coreEnvSchema = z.object({
  ...common,
  CORE_PORT: port.default(3000),
  CORE_DATABASE_URL: url,
  REDIS_URL: url,
  LIVEKIT_URL: url,
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  PAYMENT_GATEWAY_URL: url,
});

export const gatewayEnvSchema = z.object({
  ...common,
  PAYMENT_GATEWAY_PORT: port.default(3100),
  PAYMENTS_DATABASE_URL: url,
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
