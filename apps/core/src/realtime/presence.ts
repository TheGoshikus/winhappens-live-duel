import type { Redis } from 'ioredis';

/**
 * Присутствие: пользователь в сети, пока жив хотя бы один его сокет. Соединение продлевает
 * «аренду» каждые HEARTBEAT; упавший инстанс перестаёт продлевать — через TTL пользователь офлайн.
 */
export interface Presence {
  touch(userId: string, connId: string): Promise<void>;
  drop(userId: string, connId: string): Promise<void>;
  isOnline(userId: string): Promise<boolean>;
}

export const PRESENCE_TTL_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

export function createMemoryPresence(clock = () => Date.now()): Presence {
  const leases = new Map<string, Map<string, number>>();
  return {
    async touch(userId, connId) {
      const m = leases.get(userId) ?? new Map<string, number>();
      m.set(connId, clock() + PRESENCE_TTL_MS);
      leases.set(userId, m);
    },
    async drop(userId, connId) {
      leases.get(userId)?.delete(connId);
    },
    async isOnline(userId) {
      const now = clock();
      return [...(leases.get(userId)?.values() ?? [])].some((until) => until > now);
    },
  };
}

/** ZSET presence:{userId}: member = connId, score = срок аренды (мс). */
export function createRedisPresence(redis: Redis, clock = () => Date.now()): Presence {
  const key = (u: string) => `presence:${u}`;
  return {
    async touch(userId, connId) {
      await redis
        .multi()
        .zadd(key(userId), clock() + PRESENCE_TTL_MS, connId)
        .zremrangebyscore(key(userId), 0, clock())
        .pexpire(key(userId), PRESENCE_TTL_MS * 2)
        .exec();
    },
    async drop(userId, connId) {
      await redis.zrem(key(userId), connId);
    },
    async isOnline(userId) {
      return (await redis.zcount(key(userId), clock() + 1, '+inf')) > 0;
    },
  };
}
