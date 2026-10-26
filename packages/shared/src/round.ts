import { z } from 'zod';
import { minorSchema, positiveMinorSchema } from './money.js';

/**
 * Режим «Крупье отвечает взаимностью»: фиксированный список — только аксессуары и верхняя одежда.
 * Цена — ставка под предметом в целых фишках/USDT; в minor units умножается на 10^exponent.
 */
export const RECIPROCITY_ITEMS = [
  { id: 'glasses', price: 5 },
  { id: 'hat', price: 5 },
  { id: 'scarf', price: 10 },
  { id: 'earrings', price: 10 },
  { id: 'gloves', price: 15 },
  { id: 'shoes', price: 20 },
  { id: 'jacket', price: 25 },
] as const;
export type ReciprocityItemId = (typeof RECIPROCITY_ITEMS)[number]['id'];
export const reciprocityItemSchema = z.enum([
  'glasses',
  'hat',
  'scarf',
  'earrings',
  'gloves',
  'shoes',
  'jacket',
]);
/** Раундов с крупье до режима взаимности. */
export const RECIPROCITY_AFTER_ROUNDS = 3;

const hex = (len?: number) =>
  len ? z.string().regex(new RegExp(`^[0-9a-f]{${len}}$`)) : z.string().regex(/^[0-9a-f]+$/);

/** commit = sha256("{number}:{salt}") в hex; salt — не меньше 16 случайных байт в hex. */
export const roundCreateSchema = z.object({
  dealerId: z.string().uuid(),
  stake: positiveMinorSchema,
  item: reciprocityItemSchema.optional(),
});
export const roundCommitSchema = z.object({ commit: hex(64) });
export const roundRevealSchema = z.object({
  number: z.number().int().min(0).max(9),
  salt: z.string().regex(/^[0-9a-f]{32,128}$/),
});

export const roundViewSchema = z.object({
  id: z.string().uuid(),
  dealerId: z.string().uuid(),
  playerId: z.string().uuid(),
  /** Место смотрящего: 0 — игрок (ЧЁТ), 1 — крупье (НЕЧЁТ). */
  seat: z.union([z.literal(0), z.literal(1)]),
  currency: z.enum(['USDT', 'FUN']),
  stake: minorSchema,
  item: reciprocityItemSchema.nullable(),
  status: z.enum(['commit', 'reveal', 'settled', 'cancelled']),
  commitDeadline: z.string(),
  revealDeadline: z.string().nullable(),
  committed: z.object({ player: z.boolean(), dealer: z.boolean() }),
  revealed: z.object({ player: z.boolean(), dealer: z.boolean() }),
  result: z
    .object({
      outcome: z.enum(['normal', 'forfeit']),
      playerNumber: z.number().int().nullable(),
      dealerNumber: z.number().int().nullable(),
      winnerSeat: z.union([z.literal(0), z.literal(1)]),
      prize: minorSchema,
      winFee: minorSchema,
      stakeFee: minorSchema,
      signature: z.string(),
    })
    .nullable(),
});
export type RoundView = z.infer<typeof roundViewSchema>;
export type RoundViewWire = z.input<typeof roundViewSchema>;
export const dealerRoundsResponseSchema = z.object({ rounds: z.array(roundViewSchema) });
