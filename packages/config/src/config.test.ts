import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  gameEnvKeys,
  geoPolicyFromEnv,
  loadCoreConfig,
  loadGatewayConfig,
} from './index.js';

const coreEnv = {
  CORE_DATABASE_URL: 'postgres://u:p@localhost:5432/core',
  REDIS_URL: 'redis://localhost:6379',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  PAYMENT_GATEWAY_URL: 'http://localhost:3100',
  JWT_SECRET: 'j'.repeat(32),
};

describe('config', () => {
  it('применяет значения по умолчанию', () => {
    const { env, game } = loadCoreConfig(coreEnv);
    expect(env.CORE_PORT).toBe(3000);
    expect(game.sessionDurationSec).toBe(300);
    expect(game.seatHoldSec).toBe(10);
    expect(game.shiftDecisionSec).toBe(15);
    expect(game.reconnectGraceSec).toBe(30);
    expect(game.minStakeUsdt).toBe(1_000_000n);
    expect(game.minStakeFun).toBe(100n);
  });

  it('читает игровые параметры из GAME_*', () => {
    expect(gameEnvKeys.winFeeBps).toBe('GAME_WIN_FEE_BPS');
    const { game } = loadCoreConfig({
      ...coreEnv,
      GAME_WIN_FEE_BPS: '250',
      GAME_ROUNDS_BUFFER: '8',
    });
    expect(game.winFeeBps).toBe(250);
    expect(game.stakeFeeBps).toBe(229);
    expect(game.reciprocityWinFeeBps).toBe(2_000);
    expect(game.roundsBuffer).toBe(8);
  });

  it('валидирует и перечисляет все ошибки', () => {
    const bad = {
      ...coreEnv,
      REDIS_URL: 'nope',
      GAME_WIN_FEE_BPS: '20000',
      GAME_MIN_STAKE_USDT: '0',
    };
    expect(() => loadCoreConfig(bad)).toThrow(ConfigError);
    expect(() => loadCoreConfig(bad)).toThrow(/REDIS_URL[\s\S]*/);
    expect(() => loadCoreConfig({ ...coreEnv, GAME_STAKE_FEE_BPS: '20000' })).toThrow(
      /stakeFeeBps/,
    );
  });

  it('min ставка не больше max', () => {
    expect(() =>
      loadCoreConfig({ ...coreEnv, GAME_MIN_STAKE_USDT: '500', GAME_MAX_STAKE_USDT: '100' }),
    ).toThrow(/minStakeUsdt/);
  });

  it('gateway требует свою БД', () => {
    expect(() => loadGatewayConfig({})).toThrow(/PAYMENTS_DATABASE_URL/);
    expect(
      loadGatewayConfig({ PAYMENTS_DATABASE_URL: 'postgres://x@h/payments' }).env
        .PAYMENT_GATEWAY_PORT,
    ).toBe(3100);
  });

  it('гео-политика: списки стран и булевы флаги', () => {
    const { env } = loadCoreConfig({
      ...coreEnv,
      GEO_REAL_MONEY_BLOCKED: 'us, fr',
      GEO_REQUIRE_MATCH: 'false',
    });
    expect(geoPolicyFromEnv(env).realMoneyBlocked).toEqual(new Set(['US', 'FR']));
    expect(env.GEO_REQUIRE_MATCH).toBe(false);
    expect(env.GEO_ADULT_ALLOWED).toEqual([]);
    expect(env.KYC_REQUIRED_FOR_REAL_PLAY).toBe(true);
    expect(() => loadCoreConfig({ ...coreEnv, GEO_ADULT_ALLOWED: 'Russia' })).toThrow(
      /GEO_ADULT_ALLOWED/,
    );
    expect(() => loadCoreConfig({ ...coreEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
