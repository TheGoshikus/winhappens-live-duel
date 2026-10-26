import { roundCommitSchema, roundCreateSchema, roundRevealSchema } from '@winhappens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../identity/auth.js';
import { countryFromRequest } from '../identity/geo.js';
import type { RoundService } from './service.js';

export interface RoundRoutesDeps {
  rounds: RoundService;
  countryHeader: string;
}

const idParam = z.object({ id: z.string().uuid() });

export async function roundRoutes(
  app: FastifyInstance,
  { rounds, countryHeader }: RoundRoutesDeps,
) {
  app.get('/rounds/public-key', async () => ({ alg: 'Ed25519', publicKey: rounds.publicKey }));

  app.post('/rounds', async (req, reply) => {
    const q = roundCreateSchema.parse(req.body);
    reply.code(201);
    return rounds.create(requireUser(req), q, countryFromRequest(req, countryHeader));
  });

  app.get('/rounds/:id', async (req) => rounds.get(requireUser(req), idParam.parse(req.params).id));

  app.post('/rounds/:id/commit', async (req) => {
    const { commit } = roundCommitSchema.parse(req.body);
    return rounds.commit(requireUser(req), idParam.parse(req.params).id, commit);
  });

  app.post('/rounds/:id/reveal', async (req) => {
    const { number, salt } = roundRevealSchema.parse(req.body);
    return rounds.reveal(requireUser(req), idParam.parse(req.params).id, number, salt);
  });

  app.get('/dealer/rounds', async (req) => ({ rounds: await rounds.forDealer(requireUser(req)) }));

  app.get('/dealers/:id/progress', async (req) =>
    rounds.progress(requireUser(req), idParam.parse(req.params).id),
  );
}
