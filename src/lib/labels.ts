import type { SupabaseClient } from '@supabase/supabase-js';
import { OWNER_ID } from './db';
import type { EvaluationRow, VacancyRow } from './types';

/**
 * Задача 2 слоя качества: метки владельца — единственный источник голден-сета.
 * evals/golden.json стартует пустым и растёт ТОЛЬКО из кнопок 👍/👎 в Telegram.
 * Никаких предзаполненных данных, никакого авто-обучения.
 */
export type VacancyLabel = 'relevant' | 'irrelevant';
export type LetterEvent = 'letter_ok' | 'letter_edited';

export interface LabelRow {
  vacancy_id: string;
  user_id: string;
  kind: 'vacancy' | 'letter';
  label: string;
  score: number | null; // снапшот скора на момент метки
  reasons: string[] | null; // снапшот причин скорера
  labeled_at: string;
}

/** 👍/👎 на карточке вакансии: сохраняем метку + снапшот оценки скорера. */
export async function saveVacancyLabel(db: SupabaseClient, vacancyId: string, label: VacancyLabel): Promise<void> {
  const { data: evRow } = await db
    .from('evaluations')
    .select('score, reasons')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .maybeSingle();
  const ev = evRow as Pick<EvaluationRow, 'score' | 'reasons'> | null;
  const { error } = await db.from('labels').upsert(
    {
      vacancy_id: vacancyId,
      user_id: OWNER_ID,
      kind: 'vacancy',
      label,
      score: ev?.score ?? null,
      reasons: ev?.reasons ?? null,
      labeled_at: new Date().toISOString(),
    },
    { onConflict: 'vacancy_id,user_id,kind' },
  );
  if (error) throw new Error('labels upsert: ' + error.message);
}

/** События по письмам ([✅ ок] / [✏️ править]) — тоже логируются (задача 2). */
export async function saveLetterEvent(db: SupabaseClient, vacancyId: string, event: LetterEvent): Promise<void> {
  const { error } = await db.from('labels').upsert(
    {
      vacancy_id: vacancyId,
      user_id: OWNER_ID,
      kind: 'letter',
      label: event,
      labeled_at: new Date().toISOString(),
    },
    { onConflict: 'vacancy_id,user_id,kind' },
  );
  if (error) throw new Error('labels upsert: ' + error.message);
}

/**
 * Отбор меток для экспорта в голден: только старше minAgeDays — отсекает
 * случайные/импульсивные клики (владелец успевает передумать и перекликнуть).
 */
export function filterGoldenEligible<T extends { labeled_at: string }>(
  rows: T[],
  minAgeDays: number,
  now = new Date(),
): T[] {
  const cutoff = now.getTime() - minAgeDays * 86_400_000;
  return rows.filter((r) => {
    const t = Date.parse(r.labeled_at);
    return !Number.isNaN(t) && t <= cutoff;
  });
}

/** Запись голден-сета: снапшот вакансии + метка владельца + оценка скорера на момент метки. */
export interface GoldenEntry {
  vacancy_id: string;
  title: string;
  employer: string | null;
  salary: VacancyRow['salary'];
  key_skills: string[] | null;
  description: string | null;
  label: VacancyLabel;
  score_at_label: number | null;
  reasons_at_label: string[] | null;
  labeled_at: string;
}

export function toGoldenEntry(label: LabelRow, v: VacancyRow): GoldenEntry {
  return {
    vacancy_id: label.vacancy_id,
    title: v.title,
    employer: v.employer,
    salary: v.salary,
    key_skills: v.key_skills,
    description: v.description,
    label: label.label as VacancyLabel,
    score_at_label: label.score,
    reasons_at_label: label.reasons,
    labeled_at: label.labeled_at,
  };
}
