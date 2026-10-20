import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Интеграционные тесты поднимают Postgres в Testcontainers.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
