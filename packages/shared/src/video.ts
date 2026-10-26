import { z } from 'zod';
import { currencySchema, minorSchema, positiveMinorSchema } from './money.js';

export const dealerSceneSchema = z.enum(['cabaret', 'lobby', 'nature', 'armchair']);
export type DealerScene = z.infer<typeof dealerSceneSchema>;

export const goLiveRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  scene: dealerSceneSchema,
  currency: currencySchema.default('FUN'),
  minStake: positiveMinorSchema,
});
export type GoLiveRequest = z.input<typeof goLiveRequestSchema>;

/** Доступ к комнате LiveKit: адрес сервера и токен с ограниченным сроком. */
export const roomAccessSchema = z.object({ url: z.string(), room: z.string(), token: z.string() });
export type RoomAccess = z.infer<typeof roomAccessSchema>;

export const liveDealerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scene: dealerSceneSchema,
  currency: currencySchema,
  minStake: minorSchema,
  room: z.string(),
  /** Идёт сессия с другим игроком. */
  busy: z.boolean(),
});
export type LiveDealer = z.infer<typeof liveDealerSchema>;
export const liveDealersResponseSchema = z.object({ dealers: z.array(liveDealerSchema) });
