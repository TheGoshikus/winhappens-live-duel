import {
  dealerShiftChoiceSchema,
  feedQuerySchema,
  matchRequestSchema,
  shiftChoiceSchema,
} from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../identity/auth.js';
import { countryFromRequest } from '../identity/geo.js';
import type { Matchmaking } from './service.js';

export interface MatchRoutesDeps {
  matchmaking: Matchmaking;
  countryHeader: string;
}

const idParam = z.object({ id: z.string().uuid() });

export async function matchRoutes(
  app: FastifyInstance,
  { matchmaking: mm, countryHeader }: MatchRoutesDeps,
) {
  app.post('/matches', async (req, reply) => {
    const q = matchRequestSchema.parse(req.body);
    reply.code(201);
    return mm.request(requireUser(req), q, countryFromRequest(req, countryHeader));
  });
  app.get('/matches/active', async (req) => mm.active(requireUser(req)));
  app.get('/matches/:id', async (req) => mm.get(requireUser(req), idParam.parse(req.params).id));
  app.post('/matches/:id/accept', async (req) =>
    mm.accept(requireUser(req), idParam.parse(req.params).id),
  );
  app.post('/matches/:id/decline', async (req) =>
    mm.decline(requireUser(req), idParam.parse(req.params).id),
  );
  app.post('/matches/:id/cancel', async (req) =>
    mm.cancel(requireUser(req), idParam.parse(req.params).id),
  );

  app.post('/shifts/:id/decide', async (req) => {
    const { choice } = z
      .object({ choice: z.union([shiftChoiceSchema, dealerShiftChoiceSchema]) })
      .parse(req.body);
    return mm.decide(requireUser(req), idParam.parse(req.params).id, choice);
  });
  app.post('/shifts/:id/pause', async (req) =>
    mm.pause(requireUser(req), idParam.parse(req.params).id),
  );

  app.get('/feed', async (req) => mm.feed(requireUser(req), feedQuerySchema.parse(req.query)));

  app.patch('/dealer/settings', async (req, reply) => {
    const { autoAccept } = z.object({ autoAccept: z.boolean() }).parse(req.body);
    await mm.setAutoAccept(requireUser(req), autoAccept);
    reply.code(204);
  });
}
