# WinHappens Live Duel

Дуэль чёт/нечёт 1×1 с живым видео, сессиями по 5 минут, экономикой смены и собственным платёжным шлюзом.

- [ТЗ](docs/spec.md)
- [Архитектура](docs/architecture.md)
- [Платёжный шлюз](docs/payments.md)
- [План разработки](docs/roadmap.md)
- [Решения](docs/decisions.md)
- [ТЗ на игровой экран (web)](docs/ui-spec.md)

## Разработка

Нужны Node.js 22, pnpm 10, Docker.

```sh
cp .env.example .env
pnpm install
pnpm dev          # docker compose (postgres: core + payments, redis, livekit) + все приложения
```

| Сервис          | Адрес                        |
| --------------- | ---------------------------- |
| core            | http://localhost:3000/health |
| payment-gateway | http://localhost:3100/health |
| web             | http://localhost:5173        |
| LiveKit         | ws://localhost:7880          |

`/health` отвечает 200 со статусом каждой зависимости, 503 — если какая-то недоступна.

Проверки, как в CI: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

Структура: `apps/core`, `apps/payment-gateway`, `apps/web`, `packages/shared` (деньги, zod-схемы WS-событий, DTO), `packages/config` (env и игровые параметры §14 с валидацией).

### API identity (этап 1)

| Метод                    | Назначение                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `POST /auth/guest`       | гостевой аккаунт для игры на FUN, без регистрации            |
| `POST /auth/otp/start`   | код по SMS (`phone`, E.164) или email; нужен для USDT        |
| `POST /auth/otp/verify`  | гость → registered с тем же `user_id`, или вход в аккаунт    |
| `POST /auth/refresh`     | ротация refresh-токена; повтор старого отзывает всю цепочку  |
| `POST /auth/logout`      | отзыв refresh-токена                                         |
| `GET /me`                | профиль и допуск: `playFun`, `playUsdt`, `adult`, `opposite` |
| `PATCH /me/settings`     | opt-in 18+, самоисключение (только продление)                |
| `POST /kyc/start`        | начать KYC (только registered)                               |
| `POST /dev/kyc/complete` | mock: завершить KYC (вне production)                         |

### API кошелька (этап 2)

| Метод                                                | Назначение                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /wallet`                                        | балансы USDT и FUN: `main`, `hold`, `pendingWithdrawal` (строки minor units) |
| `GET /wallet/history?currency=USDT&limit=50&before=` | проводки основного счёта, новые сверху                                       |
| `POST /dev/wallet/deposit`                           | mock `deposit.succeeded` до появления шлюза (вне production)                 |

### Видео: крупье в эфире (этап 8)

| Метод                     | Назначение                                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| `POST /dealer/live`       | открыть стол и получить токен LiveKit на публикацию (только девушка с KYC) |
| `POST /dealer/offline`    | закрыть стол                                                               |
| `GET /dealers`            | крупье в эфире                                                             |
| `POST /dealers/:id/watch` | токен LiveKit только на просмотр                                           |
| `POST /livekit/webhook`   | события LiveKit (подпись проверяется): крупье вышла — стол закрыт          |

Проверить локально: `pnpm dev`, во вкладке http://localhost:5173/#/dealer войти по коду (код — в логе core),
пройти mock-проверку личности с полом «Женский», выйти в эфир. В другом окне http://localhost:5173 игрок
увидит стол «LIVE» с живым видео в кружке и на полном экране.

### Раунды с живой крупье (этап 4)

| Метод                       | Назначение                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `POST /rounds`              | игрок открывает раунд у крупье в эфире (`dealerId`, `stake`, `item` для взаимности) |
| `POST /rounds/:id/commit`   | `sha256("{число}:{соль}")`; ставка + сбор 2,29% уходят в банк                       |
| `POST /rounds/:id/reveal`   | число и соль; второй раскрывший запускает расчёт                                    |
| `GET /rounds/:id`           | состояние; числа соперника скрыты до расчёта                                        |
| `GET /dealer/rounds`        | пульт крупье: открытые и последние раунды                                           |
| `GET /dealers/:id/progress` | сыгранные раунды с крупье и снятые предметы                                         |
| `GET /rounds/public-key`    | публичный ключ Ed25519 для проверки подписи результата                              |

Таймауты: не закоммитили оба за `seatHoldSec` (10 с) — отмена с возвратом; не раскрылся один за
`revealTimeoutSec` (10 с) — проигрыш ему. Завершённый раунд в БД неизменяем.

Страна по IP берётся из заголовка доверенного прокси (`GEO_COUNTRY_HEADER`, по умолчанию `cf-ipcountry`). В разработке OTP-код пишется в лог core.
