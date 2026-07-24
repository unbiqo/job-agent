-- JobAgent v0 — схема Supabase/Postgres (раздел 5 ТЗ + минимальные дополнения v0):
--   users.bot_state        — состояние диалога Telegram-бота (режим «✏️ Править»)
--   applications.queued_at — момент постановки в очередь (таймаут veto-режима)
--   applications.tg_message_id — id карточки в Telegram (снятие кнопок после решения)
--   hh_tokens              — access/refresh токены hh (шифруются на стороне приложения)
-- Выполнить целиком в Supabase SQL Editor.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text,
  bot_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  user_id uuid primary key references users(id) on delete cascade,
  config jsonb not null default '{}'::jsonb
);

create table if not exists profile_facts (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('resume', 'project', 'note')),
  title text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists vacancies (
  id text primary key,                       -- hh vacancy id
  user_id uuid not null references users(id),
  title text not null,
  employer text,
  salary jsonb,
  area text,
  published_at timestamptz,
  description text,                          -- очищенный от HTML текст
  key_skills text[],
  has_test boolean,
  raw jsonb,
  first_seen_at timestamptz not null default now()
);
create index if not exists vacancies_published_idx on vacancies (published_at desc);

create table if not exists evaluations (
  vacancy_id text not null references vacancies(id) on delete cascade,
  user_id uuid not null references users(id),
  prefilter text,                            -- passed | excluded:<причина>
  score int,
  verdict text,                              -- strong | partial | no
  reasons jsonb,
  red_flags jsonb,
  resume_version text,
  letter_hook text,
  created_at timestamptz not null default now(),
  primary key (vacancy_id, user_id)
);
create index if not exists evaluations_score_idx on evaluations (user_id, score desc);

create table if not exists letters (
  vacancy_id text not null references vacancies(id) on delete cascade,
  user_id uuid not null references users(id),
  text text not null,
  version int not null default 1,
  needs_review boolean not null default false, -- слой качества: не прошло валидатор дважды
  created_at timestamptz not null default now(),
  primary key (vacancy_id, user_id, version)
);

-- Слой качества (задача 8): лог итеративных правок писем через Telegram
create table if not exists letter_feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  vacancy_id text not null references vacancies(id) on delete cascade,
  letter_version int,
  feedback_text text not null,
  original_text text not null,
  revised_text text,
  status text not null default 'revised',   -- revised | validation_failed | manual
  created_at timestamptz not null default now()
);

-- Слой качества (задача 9): эталонные письма (⭐) — few-shot стиля ТОЛЬКО для промпта письма
create table if not exists curated_examples (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  vacancy_id text references vacancies(id) on delete set null,
  letter_text text not null,
  created_at timestamptz not null default now(),
  unique (user_id, vacancy_id)
);

-- Слой качества (задача 2): метки владельца — источник голден-сета
create table if not exists labels (
  vacancy_id text not null references vacancies(id) on delete cascade,
  user_id uuid not null references users(id),
  kind text not null default 'vacancy' check (kind in ('vacancy', 'letter')),
  label text not null,          -- vacancy: relevant|irrelevant; letter: letter_ok|letter_edited
  score int,                    -- снапшот скора на момент метки
  reasons jsonb,
  labeled_at timestamptz not null default now(),
  primary key (vacancy_id, user_id, kind)
);

create table if not exists applications (
  vacancy_id text not null references vacancies(id) on delete cascade,
  user_id uuid not null references users(id),
  status text not null default 'queued',     -- queued|sent|vetoed|failed|viewed|invited|rejected|offer
  queued_at timestamptz,
  sent_at timestamptz,
  response_at timestamptz,
  error text,
  tg_message_id bigint,
  manual boolean not null default false,      -- v1.1: отклик подтверждён вручную (NO_OAUTH/FALLBACK)
  polled_at timestamptz,                       -- v1.1: последний 3-дневный опрос статуса
  primary key (vacancy_id, user_id)
);
create index if not exists applications_status_idx on applications (user_id, status);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(10, 4) not null default 0
);

create table if not exists hh_tokens (
  user_id uuid primary key references users(id) on delete cascade,
  access_token text not null,                -- 'enc:...' (AES-256-GCM) либо 'plain:...'
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- RLS включён на всех таблицах; политики не создаём — в v0 доступ только через
-- service role key (anon-ключ ничего не читает).
alter table users enable row level security;
alter table settings enable row level security;
alter table profile_facts enable row level security;
alter table vacancies enable row level security;
alter table evaluations enable row level security;
alter table letters enable row level security;
alter table applications enable row level security;
alter table runs enable row level security;
alter table hh_tokens enable row level security;
alter table labels enable row level security;
alter table letter_feedback enable row level security;
alter table curated_examples enable row level security;

-- Владелец (single-user v0)
insert into users (id) values ('00000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;
insert into settings (user_id, config) values ('00000000-0000-0000-0000-000000000001', '{}')
  on conflict (user_id) do nothing;
