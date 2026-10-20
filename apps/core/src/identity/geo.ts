import type { FastifyRequest } from 'fastify';

/** Коды «страна неизвестна» у CDN (Cloudflare: XX — нет данных, T1 — Tor). */
const UNKNOWN = new Set(['XX', 'T1']);

/**
 * Страна по IP из заголовка доверенного прокси/CDN. В продакшене заголовок должен выставлять только
 * edge-прокси; сам сервис не должен быть доступен клиентам напрямую.
 */
export function countryFromRequest(req: FastifyRequest, header: string): string | null {
  const raw = req.headers[header];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) && !UNKNOWN.has(v) ? v : null;
}
