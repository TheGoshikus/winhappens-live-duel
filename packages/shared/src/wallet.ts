import { z } from 'zod';
import { currencySchema, minorSchema, positiveMinorSchema } from './money.js';

const balances = z.object({ main: minorSchema, hold: minorSchema, pendingWithdrawal: minorSchema });

/** Суммы на проводе — строки minor units (USDT: 10⁻⁶, FUN: 10⁻²). */
export const walletResponseSchema = z.object({ USDT: balances, FUN: balances });

export const walletHistoryQuerySchema = z.object({
  currency: currencySchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.bigint().positive().optional(),
});

export const walletHistoryResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      amount: minorSchema,
      balanceAfter: minorSchema,
      ref: z.object({ type: z.string(), id: z.string() }).nullable(),
      createdAt: z.string(),
    }),
  ),
  nextBefore: z.string().nullable(),
});

export const devDepositSchema = z.object({ amount: positiveMinorSchema });
