import { depositSessionSchema, payoutViewSchema } from '@winhappens/shared';
import { SIGNATURE_HEADER, signBody } from '@winhappens/shared/server';
import { AppError } from '../errors.js';

export class GatewayUnavailableError extends Error {
  override name = 'GatewayUnavailableError';
}

/** Клиент платёжного шлюза: подписанные запросы core → gateway (payments.md §2). */
export function createGatewayClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
) {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          [SIGNATURE_HEADER]: signBody(secret, method === 'GET' ? `GET ${path}` : raw),
          ...headers,
        },
        ...(body === undefined ? {} : { body: raw }),
      });
    } catch (e) {
      throw new GatewayUnavailableError(e instanceof Error ? e.message : String(e));
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status >= 500) throw new GatewayUnavailableError(`gateway HTTP ${res.status}`);
    // 4xx — решение шлюза (нет провайдера, валидация): для клиента — отказ.
    if (!res.ok) throw new AppError(422, `gateway_${json.error ?? 'rejected'}`);
    return json;
  }

  return {
    async createDeposit(
      q: { userId: string; amount: bigint; currency: 'USDT' | 'EUR'; rail: 'card' | 'crypto' },
      idempotencyKey: string,
    ) {
      return depositSessionSchema.parse(
        await call(
          'POST',
          '/v1/deposits',
          { ...q, amount: q.amount.toString() },
          { 'idempotency-key': idempotencyKey },
        ),
      );
    },
    async createPayout(q: {
      payoutId: string;
      userId: string;
      amount: bigint;
      rail: 'card' | 'crypto';
      destination: string;
    }) {
      return payoutViewSchema.parse(
        await call('POST', '/v1/payouts', { ...q, amount: q.amount.toString() }),
      );
    },
  };
}

export type GatewayClient = ReturnType<typeof createGatewayClient>;
