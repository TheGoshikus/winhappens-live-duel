import { z } from 'zod';

/** E.164 после удаления пробелов, дефисов и скобок: "+7 (999) 123-45-67" → "+79991234567". */
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s\-()]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'expected phone in E.164 format'));
export const emailSchema = z.string().trim().toLowerCase().pipe(z.string().email());

export const otpChannelSchema = z.enum(['phone', 'email']);
export type OtpChannel = z.infer<typeof otpChannelSchema>;

export const otpStartRequestSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('phone'), destination: phoneSchema }),
  z.object({ channel: z.literal('email'), destination: emailSchema }),
]);
export type OtpStartRequest = z.input<typeof otpStartRequestSchema>;

export const otpStartResponseSchema = z.object({
  challengeId: z.string().uuid(),
  expiresAt: z.string(),
});

export const otpVerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

export const guestRequestSchema = z.object({
  /** Стабильный идентификатор установки клиента — для антифрода (device_link). */
  deviceId: z.string().min(8).max(128).optional(),
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(16) });

export const tokenPairSchema = z.object({
  userId: z.string().uuid(),
  accessToken: z.string(),
  accessExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshExpiresAt: z.string(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** login — контакт уже был у другого аккаунта; registered — гость стал зарегистрированным; created — новый аккаунт. */
export const otpVerifyResponseSchema = tokenPairSchema.extend({
  outcome: z.enum(['login', 'registered', 'created', 'linked']),
});

export const settingsPatchSchema = z
  .object({
    adultOptIn: z.boolean(),
    /** Самоисключение на N дней; можно только продлить. */
    selfExcludeDays: z.number().int().min(1).max(3650),
  })
  .partial();

export const kycDevCompleteSchema = z.object({
  status: z.enum(['verified', 'rejected']).default('verified'),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['male', 'female']),
  country: z.string().regex(/^[A-Z]{2}$/),
});

export const apiErrorSchema = z.object({ error: z.string(), message: z.string() });
