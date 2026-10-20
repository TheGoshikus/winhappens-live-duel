import { describe, expect, it } from 'vitest';
import { clientEventSchema, serverEventSchema } from './ws.js';

const id = '0192f8e2-7c1a-7c3e-9b1d-2f4a6b8c0d1e';

describe('ws events', () => {
  it('парсит клиентское событие и превращает ставку в bigint', () => {
    const ev = clientEventSchema.parse({ type: 'match.request', payload: { stake: '100' } });
    expect(ev).toEqual({ type: 'match.request', payload: { stake: 100n } });
  });

  it('отклоняет неизвестный тип и неверное место', () => {
    expect(clientEventSchema.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
    expect(
      clientEventSchema.safeParse({ type: 'round.seat', payload: { roundId: id, seat: 2 } })
        .success,
    ).toBe(false);
  });

  it('commit — sha-256 в hex', () => {
    const ok = { type: 'round.commit', payload: { roundId: id, commitHash: 'a'.repeat(64) } };
    expect(clientEventSchema.safeParse(ok).success).toBe(true);
    expect(
      clientEventSchema.safeParse({ ...ok, payload: { ...ok.payload, commitHash: 'abc' } }).success,
    ).toBe(false);
  });

  it('парсит wallet.updated', () => {
    const ev = serverEventSchema.parse({
      type: 'wallet.updated',
      payload: { main: '-50', hold: '0' },
      ts: 1,
    });
    expect(ev.type === 'wallet.updated' && ev.payload.main).toBe(-50n);
  });
});
