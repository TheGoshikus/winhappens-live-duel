# План разработки

Каждый этап — отдельная ветка/PR, с тестами, проходящими в CI. Критерии приёмки MVP — §15 ТЗ.

## Этап 0. Каркас

- Монорепо pnpm + Turborepo: `apps/core`, `apps/payment-gateway`, `apps/web`, `packages/shared` (zod-схемы WS-событий §12, DTO, деньги), `packages/config`.
- Docker Compose: postgres (две БД), redis, livekit.
- Линт, typecheck, Vitest, GitHub Actions CI.
- Конфиг-модуль с параметрами §14 (rake, rounds_buffer, …) и валидацией.

**Готово, когда**: `pnpm dev` поднимает всё, `/health` отвечает, CI зелёный.

## Этап 1. Identity, допуск

- users, kyc_verification (mock-провайдер), player_settings, user_block, device_link.
- Аутентификация (email/OTP или magic link + JWT/refresh).
- Модуль Eligibility: `canPlay(S)`, `canAdult`, `canStayX2`, `canOpposite`, гео-блок.

## Этап 2. Wallet + Ledger

- Двойная запись, bigint minor units, системные счета.
- Операции: credit/debit, hold/release, перевод в round_pot, выплата приза, rake.
- Property-тесты инвариантов (сумма по tx = 0, баланс ≥ 0 там, где запрещён минус, конкурентные списания).

## Этап 3. Payment gateway (MVP)

- Сервис, БД, API `createDeposit / createPayout`, вебхуки, outbox → core.
- Mock-адаптер (фиат + крипто) для разработки; интерфейс для реальных провайдеров.
- В core: обработка `deposit.succeeded`, `payout.*`, `pending_withdrawal`.

## Этап 4. Round Engine

- Место 0/1, удержание 10с, commit (hash(number‖salt)), reveal, таймаут reveal, расчёт, подпись Ed25519, журнал.
- Списание ставки на коммите, выплата через ledger.

**Критерий MVP №1.**

## Этап 5. Presence, WS-шлюз, Session

- Состояния пользователя (architecture §4), блокировки, reconnect 30с.
- Сессия 300с, депозит D_min = S × rounds_buffer, досрочное завершение при D < S, правила выхода §6.4.

## Этап 6. Matchmaking, Feed, Shift

- Очереди по ключу (S, adult, geo, gender_pref), принятие матча 5с, распределение мест, недавние соперники.
- Лента (без видео), фильтры.
- Shift 15с: next / stay ×2 / opposite / exit, max_stay_streak, пауза при инлайн-пополнении.

**Критерии MVP №3–4 (без видео).**

## Этап 7. Web-клиент (игровой поток)

- PWA: онбординг, лента со свайпом, SessionIntro, раунд, Shift, кошелёк.

## Этап 8. Видео и сцены

- LiveKit: комнаты = сессии, токены с TTL, вебхуки, превью-треки для ленты.
- Сегментация и композит в общую сцену, 4 сцены, fallback; правила камеры §6.3.

**Критерий MVP №2.**

## Этап 9. Модерация

- Жалобы, блокировки, очередь модератора, хук ИИ-модерации, `moderation.stop`, водяной знак.

**Критерий MVP №6.**

## Этап 10. Модуль 18+

- Гео-флаг, KYC + opt-in обоих, правила §9.3, уровни, события undress.*. Только после юридического заключения.

**Критерий MVP №5.**

## Этап 11. Админка

- Конфиги, сцены (CMS), очередь модерации, журнал раундов, блок-листы, выплаты на ручной проверке, отчёты по выручке.
