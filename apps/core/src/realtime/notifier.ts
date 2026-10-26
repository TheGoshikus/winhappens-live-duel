import { toWire, type ServerEventWire } from '@winhappens/shared';
import type { Changes, RoundService } from '../rounds/service.js';
import type { WalletService } from '../wallet/service.js';
import type { Bus } from './bus.js';

/** Превращает изменения домена в WS-события участникам (после коммита транзакции). */
export function createNotifier(bus: Bus, wallet: WalletService) {
  async function walletOf(userId: string) {
    const b = await wallet.balances(userId);
    const wire = (x: { main: bigint; hold: bigint; pendingWithdrawal: bigint }) => ({
      main: toWire(x.main),
      hold: toWire(x.hold),
      pendingWithdrawal: toWire(x.pendingWithdrawal),
    });
    const e: ServerEventWire = { type: 'wallet.updated', USDT: wire(b.USDT), FUN: wire(b.FUN) };
    await bus.publish(userId, e);
  }

  return {
    wallet: walletOf,
    tablesChanged: () => bus.broadcast({ type: 'dealers.updated' }),

    async changes(ch: Changes, rounds: RoundService) {
      const users = new Set<string>();
      for (const id of ch.rounds) {
        const r = await rounds.peek(id);
        for (const u of [r.player_id, r.dealer_id]) {
          users.add(u);
          await bus.publish(u, { type: 'round.updated', round: rounds.view(r, u) });
        }
      }
      for (const id of ch.sessions) {
        const s = await rounds.peekSession(id);
        for (const u of [s.player_id, s.dealer_id]) {
          users.add(u);
          await bus.publish(u, { type: 'session.updated', session: rounds.sessionView(s, u) });
        }
      }
      for (const u of users) await walletOf(u);
      if (ch.tables) await bus.broadcast({ type: 'dealers.updated' });
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
