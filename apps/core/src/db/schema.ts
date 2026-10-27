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

export type AccountType =
  | 'main'
  | 'session_hold'
  | 'pending_withdrawal'
  | 'round_pot'
  | 'house_rake'
  | 'gateway_clearing'
  | 'fun_issuance';

export interface WalletAccountTable {
  id: string;
  user_id: string | null;
  type: AccountType;
  currency: 'USDT' | 'FUN';
  allow_negative: Generated<boolean>;
  /** Кэш суммы проводок; меняется только в той же транзакции, что и проводки. */
  balance: ColumnType<bigint, bigint | undefined, bigint>;
  created_at: CreatedAt;
}

export interface LedgerTxTable {
  id: string;
  kind: string;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string | null;
  created_at: CreatedAt;
}

export interface LedgerEntryTable {
  id: Generated<bigint>;
  tx_id: string;
  account_id: string;
  amount: bigint;
  balance_after: bigint;
  created_at: CreatedAt;
}

export type DealerScene = 'cabaret' | 'lobby' | 'nature' | 'armchair';

export interface DealerProfileTable {
  user_id: string;
  display_name: string;
  scene: DealerScene;
  currency: 'USDT' | 'FUN';
  min_stake: bigint;
  status: Generated<'offline' | 'live'>;
  room: string;
  went_live_at: Timestamp | null;
  updated_at: Timestamp;
  auto_accept: Generated<boolean>;
}

export interface DuelRoundTable {
  id: string;
  dealer_id: string;
  player_id: string;
  currency: 'USDT' | 'FUN';
  stake: bigint;
  item: string | null;
  status: 'commit' | 'reveal' | 'settled' | 'cancelled';
  player_commit: string | null;
  dealer_commit: string | null;
  player_number: number | null;
  player_salt: string | null;
  dealer_number: number | null;
  dealer_salt: string | null;
  commit_deadline: Timestamp;
  reveal_deadline: Timestamp | null;
  outcome: 'normal' | 'forfeit' | null;
  winner_seat: 0 | 1 | null;
  prize: bigint | null;
  win_fee: bigint | null;
  stake_fee: bigint | null;
  signature: string | null;
  created_at: CreatedAt;
  settled_at: Timestamp | null;
  session_id: string | null;
}

export interface DuelSessionTable {
  id: string;
  dealer_id: string;
  player_id: string;
  currency: 'USDT' | 'FUN';
  stake: bigint;
  deposit: bigint;
  player_hold_left: bigint;
  dealer_hold_left: bigint;
  status: 'active' | 'ended';
  end_reason: string | null;
  started_at: Timestamp;
  ends_at: Timestamp;
  ended_at: Timestamp | null;
  player_offline_at: Timestamp | null;
  dealer_offline_at: Timestamp | null;
  stay_streak: Generated<number>;
}

export type ShiftChoice = 'next' | 'stay' | 'opposite' | 'exit';

export interface MatchTicketTable {
  id: string;
  player_id: string;
  mode: 'direct' | 'random';
  currency: 'USDT' | 'FUN';
  stake: bigint;
  gender_pref: 'any' | 'opposite';
  adult: Generated<boolean>;
  player_ip_country: string | null;
  dealer_id: string | null;
  status: 'waiting' | 'offered' | 'accepted' | 'cancelled' | 'expired';
  reason: string | null;
  offer_deadline: Timestamp | null;
  excluded: ColumnType<string[], string[] | undefined, string[]>;
  stay_streak: Generated<number>;
  session_id: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface ShiftTable {
  id: string;
  session_id: string;
  dealer_id: string;
  player_id: string;
  currency: 'USDT' | 'FUN';
  stake: bigint;
  stay_streak: number;
  deadline: Timestamp;
  paused: Generated<boolean>;
  player_choice: ShiftChoice | null;
  dealer_choice: 'stay' | 'next' | null;
  status: 'open' | 'resolved';
  outcome: string | null;
  next_session_id: string | null;
  created_at: CreatedAt;
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
  wallet_account: WalletAccountTable;
  ledger_tx: LedgerTxTable;
  ledger_entry: LedgerEntryTable;
  dealer_profile: DealerProfileTable;
  duel_round: DuelRoundTable;
  duel_session: DuelSessionTable;
  match_ticket: MatchTicketTable;
  shift: ShiftTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Kyc = Selectable<KycVerificationTable>;
export type PlayerSettings = Selectable<PlayerSettingsTable>;
