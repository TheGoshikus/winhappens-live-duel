import { z } from 'zod';
import { currencySchema, minorSchema } from './money.js';
import { roundViewSchema } from './round.js';

/**
 * WS-протокол core ↔ клиент (architecture §2). Команды идут через REST, сокет — для событий
 * сервера: клиенту не нужно опрашивать. Конверт: { type, ...поля }.
 *
 * Авторизация — первым сообщением (токен не попадает в URL и логи прокси).
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

const balances = z.object({ main: minorSchema, hold: minorSchema, pendingWithdrawal: minorSchema });

export const sessionViewSchema = z.object({
  id: z.string().uuid(),
  dealerId: z.string().uuid(),
  playerId: z.string().uuid(),
  seat: z.union([z.literal(0), z.literal(1)]),
  currency: currencySchema,
  /** Ставка S сессии. */
  stake: minorSchema,
  /** Депозит сессии D = S × roundsBuffer у каждого участника. */
  deposit: minorSchema,
  /** Сколько осталось в депозите у смотрящего / у соперника. */
  holdLeft: minorSchema,
  opponentHoldLeft: minorSchema,
  status: z.enum(['active', 'ended']),
  endReason: z.string().nullable(),
  startedAt: z.string(),
  endsAt: z.string(),
  /** Соперник не в сети с этого момента (переподключение — до reconnectGraceSec). */
  opponentOfflineAt: z.string().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
export type SessionViewWire = z.input<typeof sessionViewSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), userId: z.string().uuid() }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('wallet.updated'), USDT: balances, FUN: balances }),
  z.object({ type: z.literal('round.updated'), round: roundViewSchema }),
  z.object({ type: z.literal('session.updated'), session: sessionViewSchema }),
  /** Состав столов в эфире изменился — перечитать GET /dealers. */
  z.object({ type: z.literal('dealers.updated') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventWire = z.input<typeof serverEventSchema>;
