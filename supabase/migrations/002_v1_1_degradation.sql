-- v1.1–v1.2 миграция (аддитивно к схеме v0). Выполнить в Supabase SQL Editor,
-- если БД уже создана по исходной schema.sql. Идемпотентно.

-- Режим NO_OAUTH/FALLBACK: ручное подтверждение отклика и 3-дневный опрос статуса
alter table applications add column if not exists manual boolean not null default false;
alter table applications add column if not exists polled_at timestamptz;
