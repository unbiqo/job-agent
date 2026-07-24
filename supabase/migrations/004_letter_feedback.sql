-- Задачи 8–9 слоя качества. Аддитивно, идемпотентно.

-- Задача 8: лог итеративных правок писем через Telegram
create table if not exists letter_feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  vacancy_id text not null references vacancies(id) on delete cascade,
  letter_version int,                       -- версия письма ДО правки
  feedback_text text not null,              -- что попросил поправить владелец
  original_text text not null,
  revised_text text,
  status text not null default 'revised',   -- revised | validation_failed | manual
  created_at timestamptz not null default now()
);
alter table letter_feedback enable row level security;

-- Задача 9: эталонные письма (кнопка ⭐ на финальном одобренном письме).
-- Влияют ТОЛЬКО на промпт письма (few-shot стиля), скоринг их не видит.
create table if not exists curated_examples (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  vacancy_id text references vacancies(id) on delete set null,
  letter_text text not null,
  created_at timestamptz not null default now(),
  unique (user_id, vacancy_id)
);
alter table curated_examples enable row level security;
