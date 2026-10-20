import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { OtpChannel } from '@winhappens/shared';

export interface OtpSender {
  send(channel: OtpChannel, destination: string, code: string): Promise<void>;
}

/** Для разработки и тестов: код пишется в лог и запоминается. Реальные SMS/email — отдельные адаптеры. */
export class MockOtpSender implements OtpSender {
  readonly sent: { channel: OtpChannel; destination: string; code: string }[] = [];
  constructor(private readonly log?: (msg: string) => void) {}

  async send(channel: OtpChannel, destination: string, code: string) {
    this.sent.push({ channel, destination, code });
    this.log?.(`[mock-otp] ${channel} ${destination}: ${code}`);
  }

  lastCodeFor(destination: string): string | undefined {
    return this.sent.findLast((s) => s.destination === destination)?.code;
  }
}

export const generateOtpCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

/** HMAC с серверным секретом: утечка таблицы не даёт перебрать 10⁶ кодов офлайн. */
export const hashOtp = (secret: string, challengeId: string, code: string) =>
  createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');

export function otpMatches(
  secret: string,
  challengeId: string,
  code: string,
  expectedHash: string,
) {
  const a = Buffer.from(hashOtp(secret, challengeId, code), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
