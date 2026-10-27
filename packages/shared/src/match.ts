import { z } from 'zod';
import { currencySchema, minorSchema, positiveMinorSchema } from './money.js';
import { dealerSceneSchema } from './video.js';

export const genderPrefSchema = z.enum(['any', 'opposite']);

/** Заявка на матч: dealerId — прямая (тап по карточке), без него — «Случайный». */
export const matchRequestSchema = z.object({
  dealerId: z.string().uuid().optional(),
  stake: positiveMinorSchema,
  currency: currencySchema.default('FUN'),
  genderPref: genderPrefSchema.default('any'),
});

export const matchViewSchema = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
  dealerId: z.string().uuid().nullable(),
  mode: z.enum(['direct', 'random']),
  currency: currencySchema,
  stake: minorSchema,
  status: z.enum(['waiting', 'offered', 'accepted', 'cancelled', 'expired']),
  reason: z.string().nullable(),
  offerDeadline: z.string().nullable(),
  sessionId: z.string().uuid().nullable(),
});
export type MatchView = z.infer<typeof matchViewSchema>;
export type MatchViewWire = z.input<typeof matchViewSchema>;

export const shiftChoiceSchema = z.enum(['next', 'stay', 'opposite', 'exit']);
export type ShiftChoice = z.infer<typeof shiftChoiceSchema>;
/** Крупье на смене: остаться с игроком или освободить стол. */
export const dealerShiftChoiceSchema = z.enum(['stay', 'next']);

export const shiftViewSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  dealerId: z.string().uuid(),
  playerId: z.string().uuid(),
  seat: z.union([z.literal(0), z.literal(1)]),
  currency: currencySchema,
  /** Ставка прошедшей сессии; «остаться ×2» — удвоенная. */
  stake: minorSchema,
  stayStake: minorSchema,
  /** Можно ли «остаться ×2»: лимит серии и депозит. */
  canStay: z.boolean(),
  stayStreak: z.number().int(),
  deadline: z.string(),
  paused: z.boolean(),
  myChoice: z.string().nullable(),
  opponentChose: z.boolean(),
  status: z.enum(['open', 'resolved']),
  /** stay — новая сессия с той же крупье; next/opposite — подбор; exit — в ленту. */
  outcome: z.string().nullable(),
  nextSessionId: z.string().uuid().nullable(),
});
export type ShiftView = z.infer<typeof shiftViewSchema>;
export type ShiftViewWire = z.input<typeof shiftViewSchema>;

/** Лента (без видео): карточки столов с фильтрами. */
export const feedQuerySchema = z.object({
  currency: currencySchema.optional(),
  /** Показать только столы, где моя ставка не ниже минимальной. */
  stake: z.coerce.bigint().positive().optional(),
  free: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  scene: dealerSceneSchema.optional(),
});
export const feedResponseSchema = z.object({
  cards: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      scene: dealerSceneSchema,
      currency: currencySchema,
      minStake: minorSchema,
      busy: z.boolean(),
      /** Играл с ней недавно. */
      recent: z.boolean(),
    }),
  ),
});
