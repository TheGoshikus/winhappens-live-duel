import { z } from 'zod';
import { minorSchema, positiveMinorSchema } from './money.js';

/** Рельсы оплаты (payments.md §3). */
export const railSchema = z.enum(['card', 'crypto']);
export type Rail = z.infer<typeof railSchema>;
/** Валюта платежа на входе; ledger — всегда USDT (конвертация по котировке шлюза). */
export const payCurrencySchema = z.enum(['USDT', 'EUR']);

// ---------- core → gateway ----------

export const createDepositSchema = z.object({
  userId: z.string().uuid(),
  amount: positiveMinorSchema,
  currency: payCurrencySchema,
  rail: railSchema,
});
export const createPayoutSchema = z.object({
  payoutId: z.string().uuid(),
  userId: z.string().uuid(),
  /** USDT minor units. */
  amount: positiveMinorSchema,
  rail: railSchema,
  destination: z.string().min(4).max(128),
});

export const depositSessionSchema = z.object({
  intentId: z.string().uuid(),
  status: z.enum(['created', 'pending', 'succeeded', 'failed', 'expired']),
  ledgerAmount: minorSchema,
  /** Куда отправить игрока: hosted checkout / адрес кошелька. */
  checkoutUrl: z.string().nullable(),
  address: z.string().nullable(),
});
export type DepositSession = z.infer<typeof depositSessionSchema>;

export const payoutViewSchema = z.object({
  payoutId: z.string().uuid(),
  status: z.enum(['requested', 'review', 'approved', 'sent', 'succeeded', 'failed']),
});

// ---------- gateway → core (outbox) ----------

export const paymentEventSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().uuid(),
    type: z.literal('deposit.succeeded'),
    intentId: z.string().uuid(),
    userId: z.string().uuid(),
    ledgerAmount: positiveMinorSchema,
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('deposit.failed'),
    intentId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('payout.succeeded'),
    payoutId: z.string().uuid(),
    userId: z.string().uuid(),
    amount: positiveMinorSchema,
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('payout.failed'),
    payoutId: z.string().uuid(),
    userId: z.string().uuid(),
    amount: positiveMinorSchema,
    reason: z.string(),
  }),
]);
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type PaymentEventWire = z.input<typeof paymentEventSchema>;

// ---------- клиент → core ----------

export const depositRequestSchema = z.object({
  amount: positiveMinorSchema,
  currency: payCurrencySchema.default('USDT'),
  rail: railSchema.default('card'),
});
export const withdrawalRequestSchema = z.object({
  amount: positiveMinorSchema,
  rail: railSchema.default('crypto'),
  destination: z.string().trim().min(4).max(128),
});
