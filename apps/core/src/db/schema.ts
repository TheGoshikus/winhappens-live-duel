import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | undefined, never>;

export type UserKind = 'guest' | 'registered';
export type UserStatus = 'active' | 'blocked';
export type ContactKind = 'phone' | 'email';
export type KycStatus = 'pending' | 'verified' | 'rejected';
export type Gender = 'male' | 'female';
export type DeviceLinkKind = 'device' | 'ip' | 'payment';

export interface UsersTable {
  id: string;
  kind: UserKind;
  status: Generated<UserStatus>;
  nickname: string | null;
  /** Последняя IP-страна (ISO 3166-1 alpha-2). */
  ip_country: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface UserContactTable {
  id: Generated<string>;
  user_id: string;
  kind: ContactKind;
  /** Нормализованный адрес: email в нижнем регистре, телефон в E.164. */
  value: string;
  verified_at: Timestamp;
}

export interface OtpChallengeTable {
  id: string;
  /** Пользователь, запросивший код (гость при регистрации), если был авторизован. */
  requested_by: string | null;
  channel: ContactKind;
  destination: string;
  code_hash: string;
  attempts: Generated<number>;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface RefreshTokenTable {
  id: string;
  user_id: string;
  /** Все токены одной цепочки ротации; повторное использование отзывает семейство. */
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface KycVerificationTable {
  user_id: string;
  status: KycStatus;
  provider: string;
  provider_ref: string;
  birthdate: ColumnType<string, string | null, string | null> | null;
  verified_gender: Gender | null;
  country: string | null;
  updated_at: Timestamp;
}

export interface PlayerSettingsTable {
  user_id: string;
  adult_opt_in: Generated<boolean>;
  /** USDT minor units. */
  daily_loss_limit: ColumnType<bigint, bigint | null, bigint | null> | null;
  self_excluded_until: Timestamp | null;
}

export interface UserBlockTable {
  user_id: string;
  blocked_user_id: string;
  created_at: CreatedAt;
}

export interface DeviceLinkTable {
  id: Generated<string>;
  user_id: string;
  kind: DeviceLinkKind;
  fingerprint: string;
  first_seen_at: CreatedAt;
  last_seen_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  user_contact: UserContactTable;
  otp_challenge: OtpChallengeTable;
  refresh_token: RefreshTokenTable;
  kyc_verification: KycVerificationTable;
  player_settings: PlayerSettingsTable;
  user_block: UserBlockTable;
  device_link: DeviceLinkTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Kyc = Selectable<KycVerificationTable>;
export type PlayerSettings = Selectable<PlayerSettingsTable>;
