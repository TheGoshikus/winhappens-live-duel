import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { unauthorized } from '../errors.js';

export interface TokenSettings {
  secret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

const ISSUER = 'winhappens-core';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createTokens(cfg: TokenSettings, clock: () => Date = () => new Date()) {
  const key = new TextEncoder().encode(cfg.secret);

  return {
    refreshTtlSec: cfg.refreshTtlSec,

    async issueAccess(userId: string) {
      const nowSec = Math.floor(clock().getTime() / 1000);
      const exp = nowSec + cfg.accessTtlSec;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setIssuedAt(nowSec)
        .setExpirationTime(exp)
        .sign(key);
      return { token, expiresAt: new Date(exp * 1000) };
    },

    async verifyAccess(token: string): Promise<{ userId: string }> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          algorithms: ['HS256'],
          currentDate: clock(),
        });
        if (!payload.sub) throw new Error('no sub');
        return { userId: payload.sub };
      } catch {
        throw unauthorized('invalid or expired access token');
      }
    },

    /** Refresh — непрозрачная случайная строка; в БД хранится только её хэш. */
    newRefresh() {
      const token = randomBytes(32).toString('base64url');
      return {
        token,
        hash: sha256(token),
        expiresAt: new Date(clock().getTime() + cfg.refreshTtlSec * 1000),
      };
    },
  };
}

export type Tokens = ReturnType<typeof createTokens>;
