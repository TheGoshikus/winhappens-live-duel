import type { OtpChannel, TokenPair } from '@winhappens/shared';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/index.js';
import type { Gender, KycStatus } from '../db/schema.js';
import type { EligibilitySubject } from '../eligibility/index.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { KycProvider } from './kyc.js';
import { generateOtpCode, hashOtp, otpMatches, type OtpSender } from './otp.js';
import type { Tokens } from './tokens.js';
import { sha256 } from './tokens.js';

export interface IdentitySettings {
  otpSecret: string;
  otpTtlSec: number;
  otpMaxAttempts: number;
  otpMaxPerHour: number;
}

export interface IdentityDeps {
  db: Db;
  tokens: Tokens;
  otp: OtpSender;
  kyc: KycProvider;
  settings: IdentitySettings;
  clock?: () => Date;
}

export type OtpOutcome = 'login' | 'registered' | 'created' | 'linked';

const invalidRefresh = () => unauthorized('invalid refresh token');

export function createIdentityService({
  db,
  tokens,
  otp,
  kyc,
  settings,
  clock = () => new Date(),
}: IdentityDeps) {
  async function issuePair(
    userId: string,
    familyId: string = uuidv7(),
    trx: Db = db,
  ): Promise<TokenPair> {
    const refresh = tokens.newRefresh();
    await trx
      .insertInto('refresh_token')
      .values({
        id: uuidv7(),
        user_id: userId,
        family_id: familyId,
        token_hash: refresh.hash,
        expires_at: refresh.expiresAt,
      })
      .execute();
    const access = await tokens.issueAccess(userId);
    return {
      userId,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt.toISOString(),
    };
  }

  async function createUser(trx: Db, kind: 'guest' | 'registered', ipCountry: string | null) {
    const id = uuidv7();
    await trx
      .insertInto('users')
      .values({ id, kind, nickname: null, ip_country: ipCountry })
      .execute();
    await trx
      .insertInto('player_settings')
      .values({ user_id: id, daily_loss_limit: null, self_excluded_until: null })
      .execute();
    return id;
  }

  async function touch(trx: Db, userId: string, ipCountry: string | null, deviceId?: string) {
    if (ipCountry) {
      await trx
        .updateTable('users')
        .set({ ip_country: ipCountry, updated_at: clock() })
        .where('id', '=', userId)
        .execute();
    }
    if (deviceId) {
      await trx
        .insertInto('device_link')
        .values({ user_id: userId, kind: 'device', fingerprint: sha256(deviceId) })
        .onConflict((oc) =>
          oc.columns(['user_id', 'kind', 'fingerprint']).doUpdateSet({ last_seen_at: clock() }),
        )
        .execute();
    }
  }

  return {
    /** Гость: аккаунт без регистрации для игры на FUN (docs/decisions.md). */
    async createGuest(q: {
      ipCountry: string | null;
      deviceId?: string | undefined;
    }): Promise<TokenPair> {
      return db.transaction().execute(async (trx) => {
        const userId = await createUser(trx, 'guest', q.ipCountry);
        await touch(trx, userId, null, q.deviceId);
        return issuePair(userId, undefined, trx);
      });
    },

    /**
     * Ротация refresh: старый отзывается, новый — в той же семье. Предъявление уже отозванного
     * токена означает кражу — отзываем всю семью.
     */
    async refresh(refreshToken: string, ipCountry: string | null): Promise<TokenPair> {
      const result = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('refresh_token')
          .innerJoin('users', 'users.id', 'refresh_token.user_id')
          .select([
            'refresh_token.id',
            'refresh_token.user_id',
            'refresh_token.family_id',
            'refresh_token.expires_at',
            'refresh_token.revoked_at',
            'users.status',
          ])
          .where('token_hash', '=', sha256(refreshToken))
          .forUpdate('refresh_token')
          .executeTakeFirst();
        if (!row) return { error: 'invalid' as const };
        if (row.revoked_at) {
          await trx
            .updateTable('refresh_token')
            .set({ revoked_at: clock() })
            .where('family_id', '=', row.family_id)
            .where('revoked_at', 'is', null)
            .execute();
          return { error: 'reuse' as const };
        }
        if (row.expires_at <= clock() || row.status !== 'active')
          return { error: 'invalid' as const };
        await trx
          .updateTable('refresh_token')
          .set({ revoked_at: clock() })
          .where('id', '=', row.id)
          .execute();
        await touch(trx, row.user_id, ipCountry);
        return { pair: await issuePair(row.user_id, row.family_id, trx) };
      });
      if ('error' in result) throw invalidRefresh();
      return result.pair;
    },

    async logout(refreshToken: string) {
      const row = await db
        .selectFrom('refresh_token')
        .select('family_id')
        .where('token_hash', '=', sha256(refreshToken))
        .executeTakeFirst();
      if (row) {
        await db
          .updateTable('refresh_token')
          .set({ revoked_at: clock() })
          .where('family_id', '=', row.family_id)
          .where('revoked_at', 'is', null)
          .execute();
      }
    },

    async startOtp(q: { channel: OtpChannel; destination: string; requestedBy: string | null }) {
      const hourAgo = new Date(clock().getTime() - 3600_000);
      const { count } = await db
        .selectFrom('otp_challenge')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('channel', '=', q.channel)
        .where('destination', '=', q.destination)
        .where('created_at', '>', hourAgo)
        .executeTakeFirstOrThrow();
      if (Number(count) >= settings.otpMaxPerHour)
        throw new AppError(429, 'otp_rate_limited', 'too many codes requested');

      const id = uuidv7();
      const code = generateOtpCode();
      const expiresAt = new Date(clock().getTime() + settings.otpTtlSec * 1000);
      await db
        .insertInto('otp_challenge')
        .values({
          id,
          requested_by: q.requestedBy,
          channel: q.channel,
          destination: q.destination,
          code_hash: hashOtp(settings.otpSecret, id, code),
          expires_at: expiresAt,
          consumed_at: null,
          // created_at по часам сервиса, чтобы лимит в час считался по тем же часам
          created_at: clock(),
        })
        .execute();
      await otp.send(q.channel, q.destination, code);
      return { challengeId: id, expiresAt: expiresAt.toISOString() };
    },

    /**
     * Подтверждение OTP:
     * - контакт уже у кого-то → вход в тот аккаунт (login);
     * - авторизованный гость → становится registered с тем же user_id;
     * - авторизованный registered → контакт добавляется (linked);
     * - без авторизации и контакт новый → новый registered-аккаунт (created).
     */
    async verifyOtp(q: {
      challengeId: string;
      code: string;
      requestedBy: string | null;
      ipCountry: string | null;
    }) {
      const result = await db.transaction().execute(async (trx) => {
        const ch = await trx
          .selectFrom('otp_challenge')
          .selectAll()
          .where('id', '=', q.challengeId)
          .forUpdate()
          .executeTakeFirst();
        if (!ch || ch.consumed_at || ch.expires_at <= clock())
          return { error: 'otp_invalid' as const };
        if (ch.attempts >= settings.otpMaxAttempts)
          return { error: 'otp_attempts_exceeded' as const };
        // Код запрошен одним пользователем — подтвердить его может только он же (или аноним — анонимный).
        if (ch.requested_by !== q.requestedBy) return { error: 'otp_invalid' as const };
        if (!otpMatches(settings.otpSecret, ch.id, q.code, ch.code_hash)) {
          await trx
            .updateTable('otp_challenge')
            .set({ attempts: ch.attempts + 1 })
            .where('id', '=', ch.id)
            .execute();
          return { error: 'otp_invalid' as const };
        }
        await trx
          .updateTable('otp_challenge')
          .set({ consumed_at: clock() })
          .where('id', '=', ch.id)
          .execute();

        const owner = await trx
          .selectFrom('user_contact')
          .select('user_id')
          .where('kind', '=', ch.channel)
          .where('value', '=', ch.destination)
          .executeTakeFirst();

        let userId: string;
        let outcome: OtpOutcome;
        if (owner) {
          userId = owner.user_id;
          outcome = 'login';
        } else {
          const requester = q.requestedBy
            ? await trx
                .selectFrom('users')
                .select(['id', 'kind'])
                .where('id', '=', q.requestedBy)
                .forUpdate()
                .executeTakeFirst()
            : undefined;
          if (requester) {
            userId = requester.id;
            outcome = requester.kind === 'guest' ? 'registered' : 'linked';
            if (requester.kind === 'guest') {
              await trx
                .updateTable('users')
                .set({ kind: 'registered', updated_at: clock() })
                .where('id', '=', userId)
                .execute();
            }
          } else {
            userId = await createUser(trx, 'registered', q.ipCountry);
            outcome = 'created';
          }
          await trx
            .insertInto('user_contact')
            .values({
              user_id: userId,
              kind: ch.channel,
              value: ch.destination,
              verified_at: clock(),
            })
            .execute();
        }

        const status = await trx
          .selectFrom('users')
          .select('status')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        if (status.status !== 'active') return { error: 'user_blocked' as const };
        await touch(trx, userId, q.ipCountry);
        return { pair: await issuePair(userId, undefined, trx), outcome };
      });
      if ('error' in result) {
        if (result.error === 'user_blocked') throw forbidden('user_blocked');
        throw new AppError(result.error === 'otp_attempts_exceeded' ? 429 : 400, result.error);
      }
      return { ...result.pair, outcome: result.outcome };
    },

    async startKyc(userId: string) {
      const user = await db
        .selectFrom('users')
        .select('kind')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      if (user.kind !== 'registered') throw forbidden('registration_required');
      const existing = await db
        .selectFrom('kyc_verification')
        .select('status')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing?.status === 'verified') throw new AppError(409, 'kyc_already_verified');
      const started = await kyc.start(userId);
      await db
        .insertInto('kyc_verification')
        .values({
          user_id: userId,
          status: 'pending',
          provider: kyc.id,
          provider_ref: started.providerRef,
          birthdate: null,
          verified_gender: null,
          country: null,
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            status: 'pending',
            provider: kyc.id,
            provider_ref: started.providerRef,
            updated_at: clock(),
          }),
        )
        .execute();
      return started;
    },

    /** Результат проверки от провайдера (вебхук; в разработке — /dev/kyc/complete). */
    async completeKyc(
      userId: string,
      r: {
        status: Exclude<KycStatus, 'pending'>;
        birthdate: string;
        gender: Gender;
        country: string;
      },
    ) {
      const res = await db
        .updateTable('kyc_verification')
        .set({
          status: r.status,
          birthdate: r.birthdate,
          verified_gender: r.gender,
          country: r.country,
          updated_at: clock(),
        })
        .where('user_id', '=', userId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw new AppError(409, 'kyc_not_pending');
    },

    async updateSettings(
      userId: string,
      patch: { adultOptIn?: boolean | undefined; selfExcludeDays?: number | undefined },
    ) {
      await db.transaction().execute(async (trx) => {
        const cur = await trx
          .selectFrom('player_settings')
          .selectAll()
          .where('user_id', '=', userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const set: { adult_opt_in?: boolean; self_excluded_until?: Date } = {};
        if (patch.adultOptIn !== undefined) set.adult_opt_in = patch.adultOptIn;
        if (patch.selfExcludeDays !== undefined) {
          const until = new Date(clock().getTime() + patch.selfExcludeDays * 86_400_000);
          // Самоисключение можно только продлить (responsible gaming).
          if (!cur.self_excluded_until || until > cur.self_excluded_until)
            set.self_excluded_until = until;
        }
        if (Object.keys(set).length)
          await trx.updateTable('player_settings').set(set).where('user_id', '=', userId).execute();
      });
    },

    async getProfile(userId: string) {
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user) throw unauthorized('user not found');
      const [contacts, kycRow, settingsRow] = await Promise.all([
        db
          .selectFrom('user_contact')
          .select(['kind', 'value', 'verified_at'])
          .where('user_id', '=', userId)
          .execute(),
        db
          .selectFrom('kyc_verification')
          .selectAll()
          .where('user_id', '=', userId)
          .executeTakeFirst(),
        db
          .selectFrom('player_settings')
          .selectAll()
          .where('user_id', '=', userId)
          .executeTakeFirst(),
      ]);
      return { user, contacts, kyc: kycRow ?? null, settings: settingsRow ?? null };
    },

    /** Снимок для Eligibility. ipCountry — страна текущего запроса, а не сохранённая. */
    async getSubject(userId: string, ipCountry: string | null): Promise<EligibilitySubject> {
      const p = await this.getProfile(userId);
      return {
        user: { kind: p.user.kind, status: p.user.status },
        kyc: p.kyc && {
          status: p.kyc.status,
          birthdate: p.kyc.birthdate,
          verifiedGender: p.kyc.verified_gender,
          country: p.kyc.country?.trim() ?? null,
        },
        settings: p.settings && {
          adultOptIn: p.settings.adult_opt_in,
          selfExcludedUntil: p.settings.self_excluded_until,
        },
        ipCountry,
      };
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
