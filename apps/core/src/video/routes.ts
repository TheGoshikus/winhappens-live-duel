import { goLiveRequestSchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../errors.js';
import { requireUser } from '../identity/auth.js';
import type { LiveKit } from './livekit.js';
import type { VideoService } from './service.js';

export interface VideoRoutesDeps {
  video: VideoService;
  livekit: LiveKit;
}

export async function videoRoutes(app: FastifyInstance, { video, livekit }: VideoRoutesDeps) {
  app.post('/dealer/live', async (req) => {
    const q = goLiveRequestSchema.parse(req.body);
    return video.goLive(requireUser(req), q);
  });

  app.post('/dealer/offline', async (req, reply) => {
    await video.goOffline(requireUser(req));
    reply.code(204);
  });

  app.get('/dealers', async (req) => {
    requireUser(req);
    return { dealers: await video.liveDealers() };
  });

  app.post('/dealers/:id/watch', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return video.watch(requireUser(req), id);
  });

  // LiveKit шлёт application/webhook+json; подпись проверяется по сырому телу.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/livekit/webhook', async (req, reply) => {
    let event;
    try {
      event = await livekit.receiveWebhook(String(req.body), req.headers.authorization);
    } catch {
      throw unauthorized('invalid webhook signature');
    }
    await video.onLiveKitEvent(event);
    reply.code(204);
  });
}
