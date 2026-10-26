import websocket, { type WebSocket } from '@fastify/websocket';
import { clientMessageSchema, type ServerEventWire } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Tokens } from '../identity/tokens.js';
import { BROADCAST, type Bus } from './bus.js';
import { HEARTBEAT_MS, type Presence } from './presence.js';

export interface RealtimeDeps {
  bus: Bus;
  presence: Presence;
  tokens: Tokens;
  /** Вызывается при подключении/отключении — сессии следят за переподключением. */
  onPresence?: (userId: string, online: boolean) => void;
}

const AUTH_TIMEOUT_MS = 5_000;
/** Коды закрытия: 4001 — нет/битый токен (клиент обновит токен и переподключится). */
const CLOSE_UNAUTHORIZED = 4001;

const send = (ws: WebSocket, e: ServerEventWire) =>
  ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));

/** WS-шлюз /ws: авторизация первым сообщением, доставка событий шины, присутствие. */
export async function realtimeGateway(
  app: FastifyInstance,
  { bus, presence, tokens, onPresence }: RealtimeDeps,
) {
  await app.register(websocket);
  const sockets = new Map<string, Set<WebSocket>>();

  const unsubscribe = await bus.subscribe((userId, event) => {
    const targets =
      userId === BROADCAST
        ? [...sockets.values()].flatMap((s) => [...s])
        : [...(sockets.get(userId) ?? [])];
    for (const ws of targets) send(ws, event);
  });
  app.addHook('onClose', async () => {
    await unsubscribe();
    for (const set of sockets.values()) for (const ws of set) ws.close(1001, 'server shutdown');
  });

  app.get('/ws', { websocket: true }, (ws) => {
    const connId = randomUUID();
    let userId: string | null = null;
    let heartbeat: NodeJS.Timeout | undefined;
    const authTimer = setTimeout(
      () => ws.close(CLOSE_UNAUTHORIZED, 'auth timeout'),
      AUTH_TIMEOUT_MS,
    );

    ws.on('message', async (data: Buffer) => {
      let msg;
      try {
        msg = clientMessageSchema.parse(JSON.parse(String(data)));
      } catch {
        return send(ws, { type: 'error', code: 'bad_message', message: 'unknown message' });
      }
      if (msg.type === 'ping') return send(ws, { type: 'pong' });
      if (userId) return;
      try {
        userId = (await tokens.verifyAccess(msg.token)).userId;
      } catch {
        return ws.close(CLOSE_UNAUTHORIZED, 'invalid token');
      }
      clearTimeout(authTimer);
      const set = sockets.get(userId) ?? new Set<WebSocket>();
      set.add(ws);
      sockets.set(userId, set);
      const uid = userId;
      await presence.touch(uid, connId);
      heartbeat = setInterval(() => {
        void presence.touch(uid, connId);
        ws.ping();
      }, HEARTBEAT_MS);
      onPresence?.(uid, true);
      send(ws, { type: 'ready', userId: uid });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (!userId) return;
      const uid = userId;
      sockets.get(uid)?.delete(ws);
      void presence.drop(uid, connId).then(() => onPresence?.(uid, false));
    });
  });
}
