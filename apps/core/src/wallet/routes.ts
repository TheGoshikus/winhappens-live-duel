import { devDepositSchema, toWire, walletHistoryQuerySchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { requireUser } from '../identity/auth.js';
import type { WalletService } from './service.js';

export interface WalletRoutesDeps {
  wallet: WalletService;
  devRoutes: boolean;
}

const wireBalances = (b: { main: bigint; hold: bigint; pendingWithdrawal: bigint }) => ({
  main: toWire(b.main),
  hold: toWire(b.hold),
  pendingWithdrawal: toWire(b.pendingWithdrawal),
});

export async function walletRoutes(app: FastifyInstance, { wallet, devRoutes }: WalletRoutesDeps) {
  app.get('/wallet', async (req) => {
    const userId = requireUser(req);
    // Стартовые фантики выдаются при первом обращении к кошельку (идемпотентно).
    await wallet.grantFunStarting(userId);
    const b = await wallet.balances(userId);
    return { USDT: wireBalances(b.USDT), FUN: wireBalances(b.FUN) };
  });

  app.get('/wallet/history', async (req) => {
    const userId = requireUser(req);
    const q = walletHistoryQuerySchema.parse(req.query);
    const rows = await wallet.history(userId, q.currency, { limit: q.limit, before: q.before });
    return {
      items: rows.map((r) => ({
        id: r.id.toString(),
        kind: r.kind,
        amount: toWire(r.amount),
        balanceAfter: toWire(r.balance_after),
        ref: r.ref_type && r.ref_id ? { type: r.ref_type, id: r.ref_id } : null,
        createdAt: r.created_at.toISOString(),
      })),
      nextBefore: rows.length === q.limit ? rows.at(-1)!.id.toString() : null,
    };
  });

  if (devRoutes) {
    // Имитация deposit.succeeded до появления платёжного шлюза (этап 3).
    app.post('/dev/wallet/deposit', async (req, reply) => {
      const userId = requireUser(req);
      const { amount } = devDepositSchema.parse(req.body);
      await wallet.creditDeposit({ userId, intentId: `dev-${randomUUID()}`, amount });
      reply.code(204);
    });
  }
}
