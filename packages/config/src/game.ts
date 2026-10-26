import { z } from 'zod';

/**
 * Игровые параметры (§14 ТЗ). Значения по умолчанию взяты из architecture.md / roadmap.md;
 * то, чего там нет, помечено «уточнить по §14» — сверить, когда docs/spec.md будет в репозитории.
 *
 * Переопределяются переменными окружения GAME_<UPPER_SNAKE>, например GAME_WIN_FEE_BPS=1000.
 */
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const gameConfigSchema = z
  .object({
    /** Сбор со ставки каждого участника при любом исходе, в б.п. (229 = 2,29%). */
    stakeFeeBps: int(0, 10_000).default(229),
    /** Комиссия с выигрыша победителя, в б.п. (1000 = 10%). */
    winFeeBps: int(0, 10_000).default(1_000),
    /** Комиссия с выигрыша в режиме взаимности (2000 = 20%). */
    reciprocityWinFeeBps: int(0, 10_000).default(2_000),
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
    /** Ставка S в minor units USDT (10⁻⁶): по умолчанию 1–100 USDT. Уточнить по §14. */
    minStakeUsdt: z.coerce.bigint().positive().default(1_000_000n),
    maxStakeUsdt: z.coerce.bigint().positive().default(100_000_000n),
    /** Ставка S в minor units FUN (10⁻²). */
    minStakeFun: z.coerce.bigint().positive().default(100n),
    maxStakeFun: z.coerce.bigint().positive().default(10_000n),
    /** Стартовый баланс фантиков гостя. */
    funStartingBalance: z.coerce.bigint().nonnegative().default(100_000n),
  })
  .refine((c) => c.minStakeUsdt <= c.maxStakeUsdt, {
    message: 'minStakeUsdt must be <= maxStakeUsdt',
    path: ['minStakeUsdt'],
  })
  .refine((c) => c.minStakeFun <= c.maxStakeFun, {
    message: 'minStakeFun must be <= maxStakeFun',
    path: ['minStakeFun'],
  });

export type GameConfig = z.infer<typeof gameConfigSchema>;

const toEnvKey = (k: string) => 'GAME_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

export const gameEnvKeys = Object.fromEntries(
  Object.keys(gameConfigSchema.innerType().innerType().shape).map((k) => [k, toEnvKey(k)]),
) as Record<keyof GameConfig, string>;

export function gameConfigFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [key, envKey] of Object.entries(gameEnvKeys)) {
    const v = env[envKey];
    if (v !== undefined && v !== '') raw[key] = v;
  }
  return raw;
}
