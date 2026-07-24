# Установка и деплой

Пошаговая настройка JobAgent (single-user). Все внешние сервисы умещаются в бесплатные
тарифы. Обзор проекта — в [README](../README.md).

## Оглавление

1. [Supabase](#1-supabase)
2. [Модели LLM и ключи](#2-модели-llm-и-ключи)
3. [Локальная настройка и база знаний](#3-локальная-настройка-и-база-знаний)
4. [hh OAuth](#4-hh-oauth)
5. [Telegram](#5-telegram)
6. [Первый прогон](#6-первый-прогон)
7. [Прод: GitHub Actions + Vercel](#7-прод-github-actions--vercel)
8. [Управление из Telegram](#8-управление-из-telegram)
9. [Скрипты качества](#9-скрипты-качества)

---

## 1. Supabase

1. Создайте проект на [supabase.com](https://supabase.com) (Free tier).
2. SQL Editor → выполните [supabase/schema.sql](../supabase/schema.sql). Миграции
   `002`–`004` из [supabase/migrations/](../supabase/migrations/) уже включены в
   `schema.sql` для чистой установки; для обновления существующей БД примените их по
   отдельности.
3. Скопируйте `Project URL` и `service_role key` (Settings → API) в `.env`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

RLS включён на всех таблицах; в single-user доступ идёт только через service role.

## 2. Модели LLM и ключи

`config/settings.json → llm` задаёт отдельную модель под каждую задачу: скоринг —
высокий объём и простая оценка, письма — важно качество.

| Задача | Поле | Модель по умолчанию | Цена in/out ($/M токенов) | Фолбэк-модель |
|---|---|---|---|---|
| скоринг | `llm.scorer_model` | `gemini-3.5-flash-lite` | $0.30 / $2.50 | `gemini-3.1-flash-lite` |
| письма | `llm.letter_model` | `gemini-3.5-flash` | $1.50 / $9.00 | `gemini-3-flash-preview` |

Фолбэк-модели — ручная подмена (одна строка `*_model` + цены), если основную модель
начнёт ограничивать даже платный ключ. Не путать с фолбэком по **ключам** (ниже, он
автоматический).

**Несколько ключей Gemini.** `GEMINI_API_KEY`, `GEMINI_API_KEY2` — бесплатные,
пробуются по порядку; `GEMINI_API_KEY3` (платный) включается автоматически, только
когда первые два не сработали (квота исчерпана, ключ невалиден). Реализация —
`MultiKeyGeminiClient` в [src/lib/llm/gemini.ts](../src/lib/llm/gemini.ts). Можно
оставить только `GEMINI_API_KEY` — остальные опциональны.

**Учёт стоимости честный к free tier.** Токены, обслуженные бесплатными ключами, дают
`cost_usd = $0` в `runs.stats` и дайджесте — прайс применяется только к тому, что
реально ушло на платный ключ ([src/lib/cost.ts](../src/lib/cost.ts)).

Ключ: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Модели вида
`gemini-2.5-*` не ставить (EOL 16.10.2026); алиасы `*-latest` не ставить — молчаливая
подмена модели ломает eval с версионированием промптов.

## 3. Локальная настройка и база знаний

```bash
npm install
cp .env.example .env    # заполните ключи
```

Скопируйте шаблоны профиля в рабочие файлы (они в `.gitignore`, в репозиторий не
попадают):

```bash
cp config/profile/resume_ai_engineer.md.example config/profile/resume_ai_engineer.md
cp config/profile/resume_analyst.md.example       config/profile/resume_analyst.md
cp config/profile/projects.json.example           config/profile/projects.json
cp config/profile/notes.md.example                config/profile/notes.md
```

Отредактируйте `config/settings.json`: поисковые запросы (синтаксис hh), регионы
(`113` РФ, `40` KZ, `16` UZ, `1` Москва), грейд, стоп-слова, порог (по умолчанию 7),
дневной лимит (10), режим отправки (`veto`).

В CI личные файлы недоступны (не коммитятся) — воркер читает базу знаний из таблицы
`profile_facts`. Залейте её: `npm run profile-push`.

## 4. hh OAuth

Поиск работает без авторизации; OAuth нужен для отправки откликов и синка статусов.

1. Зарегистрируйте приложение на [dev.hh.ru](https://dev.hh.ru) →
   `HH_CLIENT_ID`, `HH_CLIENT_SECRET` в `.env`.
2. `npm run hh-auth` → откройте URL, авторизуйтесь, скопируйте `?code=...`.
3. `npm run hh-auth -- <code>` — токены лягут в Supabase (шифруются
   `TOKEN_ENCRYPTION_KEY`), скрипт напечатает ваши `resume_id` — подставьте их в
   `config/settings.json → scoring.resume_versions.*.hh_resume_id`.

Пока OAuth недоступен, агент работает в режиме `NO_OAUTH` (карточки для ручного
отклика) — см. лесенку деградации в README.

## 5. Telegram

1. Создайте бота у [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`.
2. Свой `chat_id` узнайте у [@userinfobot](https://t.me/userinfobot) → env
   `TELEGRAM_CHAT_ID` (переопределяет `config/settings.json`).
3. `TELEGRAM_WEBHOOK_SECRET` — любая длинная случайная строка (проверка подлинности
   вебхука).

## 6. Первый прогон

```bash
npm run pipeline    # сбор → префильтр → скоринг → письма → карточки в TG → дайджест
```

В режиме `veto` карточки ждут решения 60 минут, затем уходят сами:
`npm run veto-sweep` (локально) или cron-воркфлоу (в проде).

## 7. Прод: GitHub Actions + Vercel

**GitHub Actions** (тяжёлые прогоны). Settings → Secrets and variables → Actions →
добавьте: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`
(и `GEMINI_API_KEY2/3`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HH_CLIENT_ID`,
`HH_CLIENT_SECRET`, `HH_USER_AGENT`, `TOKEN_ENCRYPTION_KEY`. Workflows:
[pipeline](../.github/workflows/pipeline.yml) (06:00/18:00 МСК),
[veto-sweep](../.github/workflows/veto-sweep.yml) (каждые 30 мин — включает
дельта-поллинг и 3-дневный опрос статусов).

**Vercel** (webhook + дашборд). Import репозитория → добавьте те же env +
`TELEGRAM_WEBHOOK_SECRET` и `DASHBOARD_USER` / `DASHBOARD_PASSWORD` (basic-auth
дашборда). ⚠️ Пустой `DASHBOARD_PASSWORD` = дашборд открыт всему интернету, а там
личные данные поиска — задайте пароль.

Привяжите webhook бота: `npm run tg-webhook -- https://<app>.vercel.app`.

## 8. Управление из Telegram

**Команды:** `/digest` (сводка) · `/queue` (очередь) · `/stats` (конверсия и стоимость)
· `/add <ссылка или текст>` (ручное добавление вакансии, FALLBACK) · `/pause`
· `/resume` · `/mode review|veto|autopilot`.

**Кнопки карточки:** `[✅ Отправить] [✏️ Править] [⏭ Пропустить]` +
`[👍 релевантно] [👎 мимо]`; после отправки — `[⭐ В эталоны]`.

- **✏️ Править** — бот спрашивает, что поправить; правит письмо LLM, сохраняя остальное
  (до 3 раундов, дальше принимает готовый текст целиком).
- **👍/👎** — метки релевантности копятся в голден-сет для `npm run eval`.
- **⭐ В эталоны** — одобренное письмо идёт в пул few-shot примеров стиля (включается
  флагом `letters.use_style_examples` при пуле ≥ 3).

## 9. Скрипты качества

| Команда | Что делает |
|---|---|
| `npm run eval` | регрессионный прогон скоринга по голдену → precision / recall / accuracy |
| `npm run golden:export` | метки старше N дней (дефолт 3) → `evals/golden.json` |
| `npm run stats:patterns` | частотный анализ 👍 vs 👎 (слова, вилки, работодатели) |
| `npm run distill:letters` | LLM суммаризирует жалобы на письма → патч для промпта (отчёт only) |
| `npm run profile-push` | залить базу знаний профиля в БД (для CI) |

Отчёты пишутся в `evals/reports/` (в git не коммитятся). Все параметры — в
`config/settings.json` (секции `prompts`, `evals`, `letter_validation`, `analytics`,
`letters`).
