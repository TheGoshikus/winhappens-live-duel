import { createDepositSchema, createPayoutSchema } from '@winhappens/shared';
import { SIGNATURE_HEADER, verifyBody } from '@winhappens/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MockAdapter } from './adapters/mock.js';
import { WebhookSignatureError } from './adapters/types.js';
import { GatewayError, type Gateway } from './service.js';

export interface GatewayRoutesDeps {
  gateway: Gateway;
  secret: string;
  mock: MockAdapter;
  /** Dev: mock-выплаты подтверждаются автоматически через ~1 с (адрес с «fail» — отказ). */
  autoSettleMockPayouts: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const idParam = z.object({ id: z.string().uuid() });

/** Тело как строка: подпись HMAC считается по сырым байтам. */
function rawJson(app: FastifyInstance) {
  app.addContentTypeParser(
    ['application/json', 'application/x-www-form-urlencoded'],
    { parseAs: 'string' },
    (req, body, done) => {
      (req as FastifyRequest).rawBody = String(body);
      done(null, body);
    },
  );
}

export async function gatewayRoutes(app: FastifyInstance, deps: GatewayRoutesDeps) {
  const { gateway, mock } = deps;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GatewayError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof WebhookSignatureError)
      return reply.code(401).send({ error: 'invalid_signature' });
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: 'validation_failed', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  // ---------- внутренний API для core (HMAC; в проде — ещё и mTLS) ----------
  app.register(async (api) => {
    rawJson(api);
    api.addHook('preHandler', async (req, reply) => {
      const signed = req.method === 'GET' ? `GET ${req.url}` : (req.rawBody ?? '');
      const sig = req.headers[SIGNATURE_HEADER];
      if (!verifyBody(deps.secret, signed, Array.isArray(sig) ? sig[0] : sig)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      if (req.rawBody) req.body = JSON.parse(req.rawBody);
    });

    api.post('/v1/deposits', async (req, reply) => {
      const key = z.string().min(8).max(200).parse(req.headers['idempotency-key']);
      const q = createDepositSchema.parse(req.body);
      reply.code(201);
      return gateway.createDeposit(q, key);
    });
    api.get('/v1/deposits/:id', async (req) => gateway.getDeposit(idParam.parse(req.params).id));

    api.post('/v1/payouts', async (req, reply) => {
      const q = createPayoutSchema.parse(req.body);
      const r = await gateway.createPayout(q);
      if (deps.autoSettleMockPayouts && r.status === 'sent') {
        const fail = q.destination.includes('fail');
        setTimeout(() => {
          void gateway
            .handleWebhook(
              'mock',
              mock.signedEvent({
                kind: 'payout',
                providerRef: `mock_pay_${q.payoutId}`,
                status: fail ? 'failed' : 'succeeded',
                ...(fail ? { reason: 'mock_declined' } : {}),
              }),
            )
            .catch((e) => app.log.error(e));
        }, 1_000);
      }
      reply.code(201);
      return r;
    });
    api.post('/v1/payouts/:id/review', async (req) => {
      const body = z
        .union([
          z.object({ approve: z.literal(true) }),
          z.object({ approve: z.literal(false), reason: z.string().min(1) }),
        ])
        .parse(req.body);
      return gateway.reviewPayout(idParam.parse(req.params).id, body);
    });
  });

  // ---------- вебхуки провайдеров ----------
  app.register(async (hooks) => {
    rawJson(hooks);
    hooks.post('/webhooks/:provider', async (req) => {
      const { provider } = z.object({ provider: z.string() }).parse(req.params);
      return {
        result: await gateway.handleWebhook(provider, {
          body: req.rawBody ?? '',
          headers: req.headers,
        }),
      };
    });
  });

  // ---------- страница оплаты mock-провайдера (только разработка) ----------
  app.register(async (page) => {
    rawJson(page);
    const html = (body: string) =>
      `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Mock-оплата</title><style>body{font-family:system-ui,sans-serif;background:#0B1230;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}` +
      `main{background:#141A33;border-radius:22px;padding:24px;max-width:360px;width:calc(100% - 32px)}button{width:100%;height:52px;border:0;border-radius:26px;font-weight:800;font-size:16px;margin-top:10px;cursor:pointer}` +
      `.pay{background:#fff;color:#0A0E1A}.decline{background:#ffffff1f;color:#fff}code{word-break:break-all;color:#C8CDDA}</style></head><body><main>${body}</main></body></html>`;

    page.get('/mock/checkout/:ref', async (req, reply) => {
      const { ref } = z.object({ ref: z.string() }).parse(req.params);
      const i = await gateway.intentByRef(ref);
      if (!i) return reply.code(404).type('text/html').send(html('<h2>Платёж не найден</h2>'));
      const amount =
        i.currency === 'EUR'
          ? `${(Number(i.amount) / 100).toFixed(2)} EUR`
          : `${(Number(i.amount) / 1e6).toFixed(2)} USDT`;
      const credited = (Number(i.ledger_amount) / 1e6).toFixed(2);
      const body =
        i.status === 'pending'
          ? `<h2>Mock-провайдер</h2><p>К оплате: <b>${amount}</b><br>Будет зачислено: <b>${credited} USDT</b></p>` +
            (i.address ? `<p>Адрес для перевода:<br><code>${i.address}</code></p>` : '') +
            `<form method="post" action="/mock/checkout/${ref}/pay"><button class="pay" data-mock-pay>Оплатить</button></form>` +
            `<form method="post" action="/mock/checkout/${ref}/decline"><button class="decline">Отклонить</button></form>`
          : `<h2>${i.status === 'succeeded' ? 'Оплачено ✓' : 'Платёж отклонён'}</h2><p>Можно вернуться в игру.</p>`;
      return reply.type('text/html').send(html(body));
    });

    page.post('/mock/checkout/:ref/:action', async (req, reply) => {
      const { ref, action } = z
        .object({ ref: z.string(), action: z.enum(['pay', 'decline']) })
        .parse(req.params);
      await gateway.handleWebhook(
        'mock',
        mock.signedEvent({
          kind: 'deposit',
          providerRef: ref,
          status: action === 'pay' ? 'succeeded' : 'failed',
        }),
      );
      return reply.redirect(`/mock/checkout/${ref}`, 303);
    });
  });
}
