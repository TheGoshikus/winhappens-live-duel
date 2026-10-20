import { z } from 'zod';
import { minorSchema, nonNegativeMinorSchema, positiveMinorSchema } from './money.js';

/**
 * WS-протокол core ↔ клиент.
 *
 * ЧЕРНОВИК: события собраны по architecture.md / payments.md. Сверить и дополнить по §12 ТЗ
 * (docs/spec.md) — файла ещё нет в репозитории.
 *
 * Конверт: { type, payload, ts? }; ts — серверное время в мс (architecture §6.3).
 */
const uuid = z.string().uuid();
const seat = z.union([z.literal(0), z.literal(1)]);
const hex = z.string().regex(/^[0-9a-f]+$/i);

const event = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload, ts: z.number().int().optional() });

// --- клиент → сервер ---------------------------------------------------------

export const clientEventSchema = z.discriminatedUnion('type', [
  event('feed.enter', z.object({})),
  event('match.request', z.object({ stake: positiveMinorSchema, targetUserId: uuid.optional() })),
  event('match.accept', z.object({ matchId: uuid })),
  event('match.decline', z.object({ matchId: uuid })),
  event('round.seat', z.object({ roundId: uuid, seat })),
  event('round.commit', z.object({ roundId: uuid, commitHash: hex.length(64) })),
  event(
    'round.reveal',
    z.object({ roundId: uuid, number: z.number().int().min(0), salt: hex.min(32) }),
  ),
  event(
    'shift.decide',
    z.object({
      sessionId: uuid,
      choice: z.enum(['next', 'stay', 'opposite', 'exit']),
      newStake: positiveMinorSchema.optional(),
    }),
  ),
  event('session.leave', z.object({ sessionId: uuid })),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

// --- сервер → клиент ---------------------------------------------------------

export const serverEventSchema = z.discriminatedUnion('type', [
  event(
    'match.found',
    z.object({
      matchId: uuid,
      opponentId: uuid,
      stake: minorSchema,
      acceptDeadline: z.number().int(),
    }),
  ),
  event('match.cancelled', z.object({ matchId: uuid, reason: z.string() })),
  event(
    'session.started',
    z.object({
      sessionId: uuid,
      roomId: z.string(),
      deposit: nonNegativeMinorSchema,
      endsAt: z.number().int(),
    }),
  ),
  event('session.ended', z.object({ sessionId: uuid, reason: z.string() })),
  event(
    'round.started',
    z.object({ roundId: uuid, sessionId: uuid, seatDeadline: z.number().int() }),
  ),
  event(
    'round.result',
    z.object({
      roundId: uuid,
      sum: z.number().int(),
      winnerSeat: seat,
      prize: nonNegativeMinorSchema,
      rake: nonNegativeMinorSchema,
      signature: z.string(),
    }),
  ),
  event('shift.started', z.object({ sessionId: uuid, deadline: z.number().int() })),
  event('wallet.updated', z.object({ main: minorSchema, hold: nonNegativeMinorSchema })),
  event('moderation.stop', z.object({ sessionId: uuid, reason: z.string() })),
  event('error', z.object({ code: z.string(), message: z.string() })),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
/** Форма события до парсинга (суммы — строки). Её и шлём в сокет. */
export type ServerEventWire = z.input<typeof serverEventSchema>;
