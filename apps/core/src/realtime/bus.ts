import type { ServerEventWire } from '@winhappens/shared';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

/**
 * Шина событий для пользователей: канал user:{id} (architecture §0). Публикует любой модуль,
 * доставляет WS-шлюз того инстанса, где открыт сокет.
 */
export interface Bus {
  publish(userId: string, event: ServerEventWire): Promise<void>;
  /** Все события всех пользователей — для WS-шлюза. */
  subscribe(
    handler: (userId: string, event: ServerEventWire) => void,
  ): Promise<() => Promise<void>>;
  /** Событие для всех подключённых (например, dealers.updated). */
  broadcast(event: ServerEventWire): Promise<void>;
}

const ALL = '*';

/** Один процесс: тесты и локальная разработка без Redis. */
export function createLocalBus(): Bus {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return {
    async publish(userId, event) {
      ee.emit('ev', userId, event);
    },
    async broadcast(event) {
      ee.emit('ev', ALL, event);
    },
    async subscribe(handler) {
      ee.on('ev', handler);
      return async () => void ee.off('ev', handler);
    },
  };
}

/** Несколько инстансов core: Redis pub/sub, канал ev:user:{id} и ev:all. */
export function createRedisBus(pub: Redis, sub: Redis): Bus {
  const PREFIX = 'ev:user:';
  return {
    async publish(userId, event) {
      await pub.publish(PREFIX + userId, JSON.stringify(event));
    },
    async broadcast(event) {
      await pub.publish(PREFIX + ALL, JSON.stringify(event));
    },
    async subscribe(handler) {
      const onMessage = (_pattern: string, channel: string, message: string) => {
        try {
          handler(channel.slice(PREFIX.length), JSON.parse(message) as ServerEventWire);
        } catch {
          // битое сообщение — пропускаем
        }
      };
      sub.on('pmessage', onMessage);
      await sub.psubscribe(PREFIX + '*');
      return async () => {
        sub.off('pmessage', onMessage);
        await sub.punsubscribe(PREFIX + '*');
      };
    },
  };
}

export const BROADCAST = ALL;
