# Архитектура WinHappens Live Duel

Исходное ТЗ: [spec.md](spec.md). Платёжный шлюз: [payments.md](payments.md). План работ: [roadmap.md](roadmap.md).

## 0. Принцип: всё строится вокруг `user_id`

- `user_id` (UUIDv7) — единственный сквозной идентификатор: PK пользователя, identity участника LiveKit, WS-канал `user:{user_id}`, ключ присутствия в Redis, владелец счетов кошелька, владелец платёжных методов в шлюзе.
- **Один пользователь — одно активное состояние** (лента / очередь / сессия / смена). Закрепляется блокировкой `lock:user:{id}` в Redis и проверяется при каждом переходе.
- **Eligibility** (допуск) вычисляется из `user_id`: KYC, гео, opt-in 18+, лимиты, самоисключение, антифрод. Остальные модули только спрашивают `can_*`.
- **Деньги — только через ledger** (двойная запись) по счетам `user_id`. Поля `balance` в таблице пользователя нет.

## 1. Модули

```mermaid
flowchart TB
    U(((user_id)))

    subgraph ACCESS["Допуск"]
        ID[Identity / Profile]
        KYC[KYC & Geo]
        RG[Responsible Gaming]
        AF[Antifraud]
        SOC[Social: блок-лист, недавние соперники]
    end

    subgraph MONEY["Деньги"]
        W[Wallet + Ledger]
        PGW[Payment Gateway<br/>отдельный сервис]
    end

    subgraph PLAY["Игра"]
        PR[Presence]
        FEED[Feed]
        MM[Matchmaking]
        SES[Session]
        RND[Round Engine]
        SH[Shift]
        UND[Undress 18+]
    end

    subgraph MEDIA["Видео и безопасность"]
        LK[LiveKit SFU]
        MOD[Moderation]
    end

    ADM[Admin / Config / CMS]

    U --- ID & KYC & RG & AF & SOC
    U --- W
    U --- PR
    KYC & RG & AF & SOC -->|Eligibility| MM
    KYC & RG -->|Eligibility| UND
    PR --> FEED --> MM --> SES
    SES --> RND --> W
    SES --> SH --> MM
    SH --> UND
    SES --> LK --> MOD
    MOD -->|moderation.stop| SES
    PGW <-->|события, outbox| W
    ADM -.-> SES & MOD & UND & RND & PGW
```

## 2. Контейнеры

```mermaid
flowchart LR
    subgraph Client["web — PWA (React + Vite)"]
        UI[Feed / Session / Shift]
        SEG[MediaPipe + WebGL сцена]
        LKC[LiveKit client]
    end

    subgraph Core["core — модульный монолит (Fastify)"]
        API[REST API]
        WSG[WS Gateway]
        DOM[Домены]
        TMR[Таймеры / джобы]
    end

    subgraph Pay["payment-gateway — отдельный сервис"]
        PAPI[Internal API]
        ROUTER[Routing / cascade]
        ADP[Адаптеры провайдеров<br/>fiat · crypto]
        PWH[Webhook intake]
    end

    PG[(Postgres core)]
    PGP[(Postgres payments)]
    RD[(Redis)]
    LK[LiveKit SFU]
    MODW[Moderation worker]
    KYCP[KYC-провайдер]
    FIAT[Фиат-провайдеры]
    CRYPTO[Крипто-провайдеры]

    UI <-->|WS| WSG
    UI -->|HTTPS| API
    UI -->|hosted checkout / iframe| ADP
    LKC <-->|WebRTC| LK
    SEG --> LKC
    API & WSG --> DOM --> PG & RD
    TMR --> DOM
    DOM -->|токены| LK
    LK -->|webhooks| DOM
    LK --> MODW --> DOM
    KYCP --> DOM
    DOM <-->|mTLS + подписанные события| PAPI
    PAPI --> ROUTER --> ADP --> FIAT & CRYPTO
    FIAT & CRYPTO --> PWH --> PGP
    PAPI --> PGP
```

## 3. Модель данных (core)

```mermaid
erDiagram
    USERS ||--|| KYC_VERIFICATION : ""
    USERS ||--|| PLAYER_SETTINGS : ""
    USERS ||--o{ WALLET_ACCOUNT : ""
    WALLET_ACCOUNT ||--o{ LEDGER_ENTRY : ""
    USERS ||--o{ DEVICE_LINK : ""
    USERS ||--o{ USER_BLOCK : ""
    USERS ||--o{ MATCH_TICKET : ""
    USERS ||--o{ SESSION_PARTICIPANT : ""
    SESSION ||--|{ SESSION_PARTICIPANT : ""
    SESSION ||--o{ ROUND : ""
    ROUND ||--|{ ROUND_MOVE : ""
    USERS ||--o{ ROUND_MOVE : ""
    SESSION ||--o{ SHIFT_DECISION : ""
    USERS ||--o{ SHIFT_DECISION : ""
    SESSION ||--o{ UNDRESS_EVENT : ""
    USERS ||--o{ UNDRESS_EVENT : ""
    USERS ||--o{ REPORT : ""
    SESSION ||--o{ MODERATION_EVENT : ""
    SCENE ||--o{ SESSION : ""
```

| Таблица | Ключевые поля |
| --- | --- |
| users | id, nickname, country, status |
| kyc_verification | user_id, status, birthdate, verified_gender, provider_ref |
| player_settings | user_id, adult_opt_in, daily_loss_limit, self_excluded_until |
| wallet_account | id, user_id (null для системных), type `main / session_hold / pending_withdrawal / round_pot / house_rake / gateway_clearing`, currency |
| ledger_tx / ledger_entry | tx_id, account_id, amount (bigint, minor units), ref_type, ref_id; сумма по tx = 0 |
| device_link | user_id, kind `device / ip / payment`, fingerprint |
| user_block | user_id, blocked_user_id |
| match_ticket | id, user_id, stake, deposit, adult, gender_pref, geo, status |
| session | id, room_id, scene_id, adult_mode, started_at, ends_at, status |
| session_participant | session_id, user_id, seat, stake_S, deposit_D, hold_account_id, undress_level, stay_streak |
| round / round_move | round: id, session_id, sum, winner_seat, prize, rake, signature; move: round_id, user_id, seat, commit_hash, number, salt, stake |
| shift_decision | session_id, user_id, choice, undress, new_S, new_D |
| undress_event | session_id, user_id, level, confirmed_at |
| report / moderation_event | reporter_id, target_user_id, session_id, type, source, action, snapshot_url |

Отличия от §11 ТЗ: баланс → ledger; S/D — на участника (в 18+ ставки асимметричны); пол — только `verified_gender` из KYC.

## 4. Состояние пользователя

```mermaid
stateDiagram-v2
    [*] --> OFFLINE
    OFFLINE --> IDLE: WS connect
    IDLE --> IN_FEED: «Играть» (eligibility)
    IN_FEED --> WAITING: карточка / «Случайный»
    WAITING --> MATCH_PENDING: match.found
    IN_FEED --> MATCH_PENDING: тап по карточке
    MATCH_PENDING --> WAITING: таймаут / отказ
    MATCH_PENDING --> IN_SESSION: оба приняли → hold D
    IN_SESSION --> IN_SHIFT: 5:00 или D < S
    IN_SESSION --> IN_FEED: выход (§6.4) → release
    IN_SESSION --> RECONNECTING: обрыв
    RECONNECTING --> IN_SESSION: < 30с
    RECONNECTING --> IN_FEED: > 30с
    IN_SHIFT --> MATCH_PENDING: stay (оба)
    IN_SHIFT --> WAITING: next / opposite
    IN_SHIFT --> IN_FEED: exit
```

## 5. Поток денег в игре

```mermaid
sequenceDiagram
    participant A as main(A)
    participant HA as hold(A)
    participant POT as round_pot
    participant HB as hold(B)
    participant B as main(B)
    participant H as house_rake
    A->>HA: D (старт сессии)
    B->>HB: D
    HA->>POT: S (commit)
    HB->>POT: S (commit)
    POT->>A: 2S × (1 − rake) — победитель
    POT->>H: 2S × rake
    HA->>A: остаток D (конец сессии)
    HB->>B: остаток D
```

## 6. Ключевые решения

1. **Commit–reveal с таймаутом reveal**: не прислал reveal за T секунд после двух коммитов — проигрыш (как выход после коммита, §6.4).
2. **Подпись результата** Ed25519; журнал раундов append-only.
3. **Серверное время** — единственный источник для всех таймеров (место 10с, сессия 300с, смена 15с, reconnect 30с).
4. **Деньги в целых minor units** (bigint), одна расчётная валюта ledger; конвертация — только на границе платёжного шлюза.
5. **Платёжный шлюз — отдельный сервис** со своей БД и секретами; core не знает о провайдерах.
6. **Модуль 18+ изолирован** и выключаем целиком (гео-флаг + KYC + opt-in обоих).

## 7. Стек

| Слой | Выбор |
| --- | --- |
| Язык | TypeScript везде (общие типы событий и DTO) |
| Монорепо | pnpm workspaces + Turborepo |
| Backend | Node.js 22, Fastify, `ws`, zod |
| БД | PostgreSQL 16, Kysely + миграции (явный SQL для ledger, `SERIALIZABLE`/`FOR UPDATE`) |
| Кэш/очереди/таймеры | Redis 7, BullMQ |
| Видео | LiveKit (self-hosted), livekit-server-sdk |
| Frontend | React + Vite, PWA, MediaPipe Selfie Segmentation, WebGL |
| Тесты | Vitest, Testcontainers (Postgres/Redis) |
| Инфраструктура | Docker Compose локально; далее k8s |
