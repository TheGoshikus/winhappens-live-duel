import {
  depositRequestSchema,
  paymentEventSchema,
  withdrawalRequestSchema,
} from '@winhappens/shared';
import { SIGNATURE_HEADER, verifyBody } from '@winhappens/shared/server';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { unauthorized } from '../errors.js';
import { requireUser } from '../identity/auth.js';
import { countryFromRequest } from '../identity/geo.js';
import type { PaymentsService } from './service.js';

export interface PaymentRoutesDeps {
  payments: PaymentsService;
  gatewaySecret: string;
  countryHeader: string;
}

export async function paymentRoutes(
  app: FastifyInstance,
  { payments, gatewaySecret, countryHeader }: PaymentRoutesDeps,
) {
  app.post('/wallet/deposits', async (req, reply) => {
    const q = depositRequestSchema.parse(req.body);
    const key =
      z.string().min(8).max(100).optional().parse(req.headers['idempotency-key']) ?? randomUUID();
    reply.code(201);
    return payments.deposit(requireUser(req), q, countryFromRequest(req, countryHeader), key);
  });

  app.post('/wallet/withdrawals', async (req, reply) => {
    const q = withdrawalRequestSchema.parse(req.body);
    reply.code(202);
    return payments.withdraw(requireUser(req), q);
  });

  // События шлюза: подпись HMAC по сырому телу.
  app.register(async (internal) => {
    internal.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    internal.post('/internal/payments/events', async (req, reply) => {
      const raw = String(req.body ?? '');
      const sig = req.headers[SIGNATURE_HEADER];
      if (!verifyBody(gatewaySecret, raw, Array.isArray(sig) ? sig[0] : sig))
        throw unauthorized('invalid gateway signature');
      await payments.handleEvent(paymentEventSchema.parse(JSON.parse(raw)));
      reply.code(204);
    });
  });
}
