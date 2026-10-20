/** Env для тестов приложения: внешние сервисы не используются, БД — из Testcontainers. */
export const testEnv = {
  NODE_ENV: 'test',
  CORE_DATABASE_URL: 'postgres://unused@localhost/core',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  PAYMENT_GATEWAY_URL: 'http://localhost:3100',
  JWT_SECRET: 'test-secret-test-secret-test-secret!',
  GEO_REAL_MONEY_BLOCKED: 'US',
  GEO_ADULT_ALLOWED: 'DE',
  OTP_MAX_ATTEMPTS: '3',
  OTP_MAX_PER_HOUR: '3',
};
