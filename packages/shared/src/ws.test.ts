import { describe, expect, it } from 'vitest';
import { clientMessageSchema, serverEventSchema } from './ws.js';

describe('ws protocol', () => {
  it('клиент: auth и ping, остальное отклоняется', () => {
    expect(clientMessageSchema.parse({ type: 'auth', token: 'x'.repeat(20) }).type).toBe('auth');
    expect(clientMessageSchema.safeParse({ type: 'auth', token: '' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'round.commit' }).success).toBe(false);
  });

  it('wallet.updated: суммы — строки на проводе, bigint после разбора', () => {
    const b = { main: '-50', hold: '0', pendingWithdrawal: '0' };
    const ev = serverEventSchema.parse({
      type: 'wallet.updated',
      USDT: b,
      FUN: { ...b, main: '100000' },
    });
    expect(ev.type === 'wallet.updated' && ev.FUN.main).toBe(100_000n);
  });
});
