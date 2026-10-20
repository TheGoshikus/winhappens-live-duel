import { z } from 'zod';

export const healthCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  uptimeSec: z.number(),
  checks: z.record(healthCheckSchema),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
