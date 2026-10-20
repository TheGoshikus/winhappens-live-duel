import { healthResponseSchema, type HealthResponse } from '@winhappens/shared';

/** /health отдаёт 503 с телом при деградации — тело всё равно разбираем. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchImpl('/api/health');
  return healthResponseSchema.parse(await res.json());
}
