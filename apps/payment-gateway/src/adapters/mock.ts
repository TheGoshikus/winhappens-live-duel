import { signBody, verifyBody } from '@winhappens/shared/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PaymentProviderAdapter, ProviderEvent, RawWebhook } from './types.js';
import { WebhookSignatureError } from './types.js';

const eventSchema = z.object({
  eventId: z.string(),
  kind: z.enum(['deposit', 'payout']),
  providerRef: z.string(),
  status: z.enum(['succeeded', 'failed']),
  reason: z.string().optional(),
});

/**
 * Mock-провайдер для разработки: фиат (hosted checkout) и крипта (адрес). Оплата подтверждается на
 * странице /mock/checkout/:ref, вебхуки подписаны тем же HMAC, что и у реальных интеграций.
 */
export class MockAdapter implements PaymentProviderAdapter {
  readonly id = 'mock';
  readonly rails = ['card', 'crypto'] as const;
  private readonly statuses = new Map<string, 'pending' | 'succeeded' | 'failed'>();

  constructor(private readonly opts: { publicUrl: string; secret: string }) {}

  supports(): boolean {
    return true;
  }

  async createDeposit(i: { intentId: string; rail: 'card' | 'crypto' }) {
    const providerRef = `mock_dep_${i.intentId}`;
    this.statuses.set(providerRef, 'pending');
    return {
      providerRef,
      checkoutUrl: `${this.opts.publicUrl}/mock/checkout/${providerRef}`,
      // Одноразовый «адрес» TRON-формата для крипто-депозита.
      address: i.rail === 'crypto' ? `T${i.intentId.replace(/-/g, '')}` : null,
    };
  }

  async createPayout(p: { payoutId: string }) {
    const providerRef = `mock_pay_${p.payoutId}`;
    this.statuses.set(providerRef, 'pending');
    return { providerRef };
  }

  async parseWebhook(raw: RawWebhook): Promise<ProviderEvent> {
    const sig = raw.headers['x-mock-signature'];
    if (!verifyBody(this.opts.secret, raw.body, Array.isArray(sig) ? sig[0] : sig)) {
      throw new WebhookSignatureError('bad mock signature');
    }
    const e = eventSchema.parse(JSON.parse(raw.body));
    this.statuses.set(e.providerRef, e.status);
    return {
      eventId: e.eventId,
      kind: e.kind,
      providerRef: e.providerRef,
      status: e.status,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }

  async fetchStatus(providerRef: string) {
    return this.statuses.get(providerRef) ?? 'pending';
  }

  /** Сформировать подписанный вебхук провайдера (страница оплаты, автопроводка выплат, тесты). */
  signedEvent(e: Omit<ProviderEvent, 'eventId'> & { eventId?: string }): RawWebhook {
    const body = JSON.stringify({ eventId: e.eventId ?? randomUUID(), ...e });
    return { body, headers: { 'x-mock-signature': signBody(this.opts.secret, body) } };
  }
}
