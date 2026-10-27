import { toWire, type ServerEventWire } from '@winhappens/shared';
import type { MatchChanges, Matchmaking } from '../matchmaking/service.js';
import type { Changes, RoundService } from '../rounds/service.js';
import type { WalletService } from '../wallet/service.js';
import type { Bus } from './bus.js';

/** Превращает изменения домена в WS-события участникам (после коммита транзакции). */
export function createNotifier(bus: Bus, wallet: WalletService) {
  /** Задаётся после создания матчмейкинга (смены открывает движок раундов). */
  let mm: Matchmaking | null = null;

  async function publishShift(id: string) {
    if (!mm) return;
    const sh = await mm.peekShift(id);
    for (const u of [sh.player_id, sh.dealer_id]) {
      await bus.publish(u, { type: 'shift.updated', shift: await mm.shiftView(sh, u) });
    }
  }

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
    useMatchmaking(m: Matchmaking) {
      mm = m;
    },

    async matchChanges(ch: MatchChanges, m: Matchmaking) {
      for (const id of ch.tickets) {
        const t = await m.peekTicket(id);
        for (const u of [t.player_id, t.dealer_id]) {
          if (u) await bus.publish(u, { type: 'match.updated', match: m.ticketView(t) });
        }
      }
      for (const id of ch.shifts) await publishShift(id);
    },
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
      for (const id of ch.shifts) await publishShift(id);
      for (const u of users) await walletOf(u);
      if (ch.tables) await bus.broadcast({ type: 'dealers.updated' });
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
