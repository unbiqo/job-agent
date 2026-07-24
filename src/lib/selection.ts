import { vacancyAgeDays } from './util';

export interface Candidate {
  vacancy_id: string;
  score: number;
  published_at: string | null;
}

/**
 * Алгоритм отбора в дневной лимит (раздел 3.5 ТЗ):
 * сортировка скор DESC, свежесть DESC; top-N; если кандидатов меньше N —
 * отправляем сколько есть (порог важнее лимита).
 */
export function selectForLimit(candidates: Candidate[], slots: number): Candidate[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      (b.published_at ? Date.parse(b.published_at) : 0) - (a.published_at ? Date.parse(a.published_at) : 0),
  );
  return ranked.slice(0, Math.max(0, slots));
}

/**
 * Свободные слоты дневного лимита (guardrail 4). Общий для основного прогона и
 * дельта-поллинга — оба вычитают уже отправленное сегодня и текущую очередь,
 * поэтому дельта расходует ОБЩИЙ лимит (спека 3.4а). Никогда не отрицателен.
 */
export function computeSlots(dailyCap: number, sentToday: number, queuedNow: number): number {
  return Math.max(0, dailyCap - sentToday - queuedNow);
}

/** Отбор действительно новых id: без уже известных в БД и без дублей внутри выборки. */
export function dedupeNewIds(fetched: string[], known: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of fetched) {
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Guardrails 1–2 перед отправкой: возраст ≤ maxAgeDays, без теста. */
export function sendEligibility(
  v: { published_at: string | null; has_test: boolean | null },
  maxAgeDays: number,
  now = new Date(),
): { ok: boolean; reason?: string } {
  if (v.has_test) return { ok: false, reason: 'has_test: нужен ручной отклик' };
  if (vacancyAgeDays(v.published_at, now) > maxAgeDays) {
    return { ok: false, reason: `вакансия старше ${maxAgeDays} дней` };
  }
  return { ok: true };
}
