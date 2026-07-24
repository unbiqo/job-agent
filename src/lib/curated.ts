import type { SupabaseClient } from '@supabase/supabase-js';
import { latestLetter } from './apply';
import type { AppConfig } from './config';
import { OWNER_ID } from './db';
import { chooseStyleExamples } from './feedback';

/**
 * Задача 9: эталонные письма (кнопка ⭐) и лог правок (задача 8).
 * ОГРАНИЧЕНИЕ ТЗ: эталоны и правки влияют только на промпт ПИСЬМА —
 * скоринг эти таблицы не читает никогда (закреплено тестом изоляции).
 */
export async function saveCuratedExample(
  db: SupabaseClient,
  vacancyId: string,
): Promise<{ ok: boolean; total: number; error?: string }> {
  const letter = await latestLetter(db, vacancyId);
  if (!letter) return { ok: false, total: 0, error: 'письма нет' };
  const { error } = await db.from('curated_examples').upsert(
    { user_id: OWNER_ID, vacancy_id: vacancyId, letter_text: letter.text },
    { onConflict: 'user_id,vacancy_id' },
  );
  if (error) return { ok: false, total: 0, error: error.message };
  const { count } = await db
    .from('curated_examples')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID);
  return { ok: true, total: count ?? 0 };
}

/** Свежие эталоны для few-shot стиля (гейт: флаг конфига + пул ≥ 3). */
export async function loadStyleExamples(db: SupabaseClient, cfg: AppConfig): Promise<string[]> {
  if (!cfg.letters.use_style_examples) return [];
  const take = cfg.letters.style_examples_count ?? 3;
  const { data } = await db
    .from('curated_examples')
    .select('letter_text')
    .eq('user_id', OWNER_ID)
    .order('created_at', { ascending: false })
    .limit(Math.max(take, 3));
  const pool = ((data ?? []) as { letter_text: string }[]).map((r) => r.letter_text);
  return chooseStyleExamples(true, pool, 3, take);
}

/** Сколько LLM-раундов правки уже потрачено на письмо этой вакансии (manual не считается). */
export async function countRevisionRounds(db: SupabaseClient, vacancyId: string): Promise<number> {
  const { count } = await db
    .from('letter_feedback')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .eq('vacancy_id', vacancyId)
    .in('status', ['revised', 'validation_failed']);
  return count ?? 0;
}

export async function logLetterFeedback(
  db: SupabaseClient,
  entry: {
    vacancy_id: string;
    letter_version: number | null;
    feedback_text: string;
    original_text: string;
    revised_text: string | null;
    status: 'revised' | 'validation_failed' | 'manual';
  },
): Promise<void> {
  const { error } = await db.from('letter_feedback').insert({ user_id: OWNER_ID, ...entry });
  if (error) console.error('letter_feedback insert: ' + error.message);
}
