import { describe, expect, it } from 'vitest';
import { signBody, verifyBody } from './server.js';

describe('HMAC-подпись тела', () => {
  const secret = 's'.repeat(32);
  it('проверяется тем же секретом, ломается при подмене тела, секрета или по времени', () => {
    const now = 1_800_000_000_000;
    const sig = signBody(secret, '{"a":1}', now);
    expect(verifyBody(secret, '{"a":1}', sig, now)).toBe(true);
    expect(verifyBody(secret, '{"a":2}', sig, now)).toBe(false);
    expect(verifyBody('x'.repeat(32), '{"a":1}', sig, now)).toBe(false);
    expect(verifyBody(secret, '{"a":1}', sig, now + 301_000)).toBe(false);
    expect(verifyBody(secret, '{"a":1}', undefined, now)).toBe(false);
    expect(verifyBody(secret, '{"a":1}', 'garbage', now)).toBe(false);
  });
});
