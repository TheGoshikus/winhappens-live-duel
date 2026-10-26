import { serverEventSchema, type ServerEvent } from '@winhappens/shared';
import { useEffect } from 'react';
import { accessToken } from './api';

type Handler<T extends ServerEvent['type']> = (e: Extract<ServerEvent, { type: T }>) => void;
type AnyHandler = (e: ServerEvent) => void;

const handlers = new Map<ServerEvent['type'], Set<AnyHandler>>();
let ws: WebSocket | null = null;
let started = false;
let retry = 0;

/** 4001 — токен не принят: обновить и переподключиться. */
const CLOSE_UNAUTHORIZED = 4001;

async function open() {
  let token: string;
  try {
    token = await accessToken();
  } catch {
    return schedule();
  }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.addEventListener('open', () => sock.send(JSON.stringify({ type: 'auth', token })));
  sock.addEventListener('message', (m) => {
    let e: ServerEvent;
    try {
      e = serverEventSchema.parse(JSON.parse(String(m.data)));
    } catch {
      return;
    }
    if (e.type === 'ready') retry = 0;
    for (const h of handlers.get(e.type) ?? []) h(e);
  });
  sock.addEventListener('close', (e) => {
    if (ws === sock) ws = null;
    schedule(e.code === CLOSE_UNAUTHORIZED ? 0 : undefined);
  });
}

/** Переподключение: 1 с, 2 с, 4 с … до 10 с (сессия ждёт reconnectGraceSec = 30 с). */
function schedule(delay?: number) {
  const ms = delay ?? Math.min(10_000, 1_000 * 2 ** retry++);
  window.setTimeout(() => void open(), ms);
}

/** Подключиться (один раз на вкладку): присутствие в сети + события сервера. */
export function connectRealtime() {
  if (started) return;
  started = true;
  void open();
}

export function onEvent<T extends ServerEvent['type']>(type: T, h: Handler<T>): () => void {
  const set = handlers.get(type) ?? new Set<AnyHandler>();
  set.add(h as AnyHandler);
  handlers.set(type, set);
  return () => set.delete(h as AnyHandler);
}

/** Подписка на событие на время жизни компонента. */
export function useServerEvent<T extends ServerEvent['type']>(type: T, h: Handler<T>) {
  useEffect(() => {
    connectRealtime();
    return onEvent(type, h);
  }, [type, h]);
}
