# WinHappens Live Duel

Дуэль чёт/нечёт 1×1 с живым видео, сессиями по 5 минут, экономикой смены и собственным платёжным шлюзом.

- [ТЗ](docs/spec.md)
- [Архитектура](docs/architecture.md)
- [Платёжный шлюз](docs/payments.md)
- [План разработки](docs/roadmap.md)
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
