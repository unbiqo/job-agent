-- Слой качества (evals + аналитика). Аддитивно к схеме v0/v1.1. Идемпотентно.

-- Задача 2: метки владельца (👍/👎 на вакансиях, события по письмам).
-- Единственный источник голден-сета: evals/golden.json растёт только отсюда.
create table if not exists labels (
  vacancy_id text not null references vacancies(id) on delete cascade,
  user_id uuid not null references users(id),
  kind text not null default 'vacancy' check (kind in ('vacancy', 'letter')),
  label text not null,          -- vacancy: relevant|irrelevant; letter: letter_ok|letter_edited
  score int,                    -- снапшот скора на момент метки
  reasons jsonb,                -- снапшот причин скорера
  labeled_at timestamptz not null default now(),
  primary key (vacancy_id, user_id, kind)
);
alter table labels enable row level security;

-- Задача 4: письмо, дважды не прошедшее детерминированный валидатор
alter table letters add column if not exists needs_review boolean not null default false;
