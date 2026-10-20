import { randomUUID } from 'node:crypto';

/** Провайдер верификации личности. Результат приходит позже (вебхук провайдера → completeKyc). */
export interface KycProvider {
  readonly id: string;
  start(userId: string): Promise<{ providerRef: string; redirectUrl: string | null }>;
}

/** Mock: проверка «завершается» через POST /dev/kyc/complete (только вне production). */
export class MockKycProvider implements KycProvider {
  readonly id = 'mock';
  async start(_userId: string) {
    return { providerRef: `mock-${randomUUID()}`, redirectUrl: null };
  }
}
