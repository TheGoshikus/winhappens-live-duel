import { z } from 'zod';

/**
 * Игровые параметры (§14 ТЗ). Значения по умолчанию взяты из architecture.md / roadmap.md;
 * то, чего там нет, помечено «уточнить по §14» — сверить, когда docs/spec.md будет в репозитории.
 *
 * Переопределяются переменными окружения GAME_<UPPER_SNAKE>, например GAME_RAKE_BPS=500.
 */
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const gameConfigSchema = z
  .object({
    /** Комиссия дома с банка раунда 2S, в б.п. (500 = 5%). Уточнить по §14. */
    rakeBps: int(0, 10_000).default(500),
    /** D_min = S × roundsBuffer (roadmap, этап 5). Уточнить по §14. */
    roundsBuffer: int(1, 1000).default(5),
    /** Длительность сессии, с (architecture §6.3). */
    sessionDurationSec: int(10, 3600).default(300),
    /** Удержание места 0/1, с. */
    seatHoldSec: int(1, 120).default(10),
    /** Таймаут reveal после двух коммитов, с (architecture §6.1, «T»). Уточнить по §14. */
    revealTimeoutSec: int(1, 120).default(10),
    /** Окно решения на экране Shift, с. */
    shiftDecisionSec: int(1, 120).default(15),
    /** Пауза Shift при инлайн-пополнении, максимум, с (payments §6). */
    inlineDepositPauseSec: int(0, 300).default(60),
    /** Окно на reconnect, с. */
    reconnectGraceSec: int(1, 300).default(30),
    /** Окно на принятие матча, с. */
    matchAcceptSec: int(1, 60).default(5),
    /** Максимум подряд «stay ×2». Уточнить по §14. */
    maxStayStreak: int(0, 100).default(3),
    /** Множитель ставки при stay. */
    stayStakeMultiplier: int(1, 10).default(2),
    /** Мин./макс. ставка S в minor units. Уточнить по §14. */
    minStakeMinor: z.coerce.bigint().positive().default(100n),
    maxStakeMinor: z.coerce.bigint().positive().default(100_000n),
  })
  .refine((c) => c.minStakeMinor <= c.maxStakeMinor, {
    message: 'minStakeMinor must be <= maxStakeMinor',
    path: ['minStakeMinor'],
  });

export type GameConfig = z.infer<typeof gameConfigSchema>;

const toEnvKey = (k: string) => 'GAME_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

export const gameEnvKeys = Object.fromEntries(
  Object.keys(gameConfigSchema.innerType().shape).map((k) => [k, toEnvKey(k)]),
) as Record<keyof GameConfig, string>;

export function gameConfigFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [key, envKey] of Object.entries(gameEnvKeys)) {
    const v = env[envKey];
    if (v !== undefined && v !== '') raw[key] = v;
  }
  return raw;
}
