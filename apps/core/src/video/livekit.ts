import { AccessToken, TrackSource, WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';

export interface LiveKitSettings {
  /** Адрес, который получают браузеры. */
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Срок жизни токена на подключение, с. Переподключение — с новым токеном. */
  tokenTtlSec?: number;
}

/**
 * Токены LiveKit (architecture §2): identity участника = user_id. Крупье публикует камеру
 * в свою комнату, игрок только смотрит.
 */
export function createLiveKit(cfg: LiveKitSettings) {
  const ttl = cfg.tokenTtlSec ?? 600;
  const receiver = new WebhookReceiver(cfg.apiKey, cfg.apiSecret);

  async function token(userId: string, name: string, room: string, publish: boolean) {
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: userId, name, ttl });
    at.addGrant({
      room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: publish,
      canPublishData: publish,
      // Крупье публикует только камеру и микрофон (без демонстрации экрана).
      ...(publish ? { canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE] } : {}),
    });
    return { url: cfg.publicUrl, room, token: await at.toJwt() };
  }

  return {
    dealerToken: (userId: string, name: string, room: string) => token(userId, name, room, true),
    viewerToken: (userId: string, room: string) => token(userId, 'viewer', room, false),
    /** Проверяет подпись вебхука LiveKit (Authorization) и разбирает событие. */
    receiveWebhook: (body: string, authorization: string | undefined): Promise<WebhookEvent> =>
      receiver.receive(body, authorization),
  };
}

export type LiveKit = ReturnType<typeof createLiveKit>;
export const dealerRoom = (userId: string) => `dealer-${userId}`;
