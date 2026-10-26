/**
 * Серверные утилиты (node:crypto) — отдельная точка входа `@winhappens/shared/server`,
 * чтобы не попадать в браузерный бандл.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-wh-signature';
/** Допустимое расхождение часов отправителя и получателя, с. */
const TOLERANCE_SEC = 300;

const mac = (secret: string, ts: number, body: string) =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** Подпись тела запроса: `t=<unix>,v1=<hmac_sha256(secret, "t.body")>` (защита от подмены и повтора). */
export function signBody(secret: string, body: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000);
  return `t=${ts},v1=${mac(secret, ts, body)}`;
}

export function verifyBody(
  secret: string,
  body: string,
  header: string | undefined,
  now = Date.now(),
): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(Math.floor(now / 1000) - ts) > TOLERANCE_SEC) return false;
  const a = Buffer.from(mac(secret, ts, body), 'hex');
  const b = Buffer.from(m[2]!, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
