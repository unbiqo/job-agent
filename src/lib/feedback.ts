/**
 * Задачи 8–9 слоя качества: чистые функции итеративной правки писем и
 * дистилляции обратной связи. Без БД и LLM — тестируются напрямую.
 */

/** Правки идут через LLM максимум N раундов (дефолт 3), дальше только ручной текст. */
export function editModeForRounds(rounds: number, maxRounds = 3): 'revise' | 'manual' {
  return rounds >= maxRounds ? 'manual' : 'revise';
}

/**
 * Гейт few-shot эталонов (задача 9): флаг в конфиге (дефолт off) И пул ≥ minPool.
 * Возвращает до take примеров. Влияет ТОЛЬКО на промпт письма.
 */
export function chooseStyleExamples(
  flagOn: boolean,
  pool: string[],
  minPool = 3,
  take = 3,
): string[] {
  if (!flagOn) return [];
  if (pool.length < minPool) return [];
  return pool.slice(0, take);
}

/** Блок примеров стиля для user-части промпта письма. Пусто — пустая строка. */
export function buildStyleExamplesBlock(examples: string[]): string {
  if (!examples.length) return '';
  const parts = examples.map((e, i) => `Пример ${i + 1}:\n${e}`);
  return (
    'ПРИМЕРЫ СТИЛЯ (подражай тону и структуре; факты бери ТОЛЬКО из PROFILE_FACTS, не из примеров):\n' +
    parts.join('\n---\n')
  );
}

export interface FeedbackForDistill {
  feedback_text: string;
  original_text: string;
  revised_text: string | null;
  status: string;
  created_at: string;
}

const CLIP = 400;
const clip = (s: string) => (s.length <= CLIP ? s : s.slice(0, CLIP) + '…');

/**
 * Вход дистилляции (задача 9): текущий промпт письма + список замечаний
 * (длинные тексты писем обрезаются — LLM нужны жалобы, а не полные письма).
 */
export function buildDistillInput(rows: FeedbackForDistill[], letterPromptText: string): string {
  const items = rows.map((r, i) =>
    [
      `### Правка ${i + 1} (${r.created_at.slice(0, 10)}, статус: ${r.status})`,
      `Замечание владельца: ${r.feedback_text}`,
      `Письмо до: ${clip(r.original_text)}`,
      r.revised_text ? `Письмо после: ${clip(r.revised_text)}` : 'Письмо после: (правка не применена)',
    ].join('\n'),
  );
  return [
    'ТЕКУЩИЙ СИСТЕМНЫЙ ПРОМПТ ПИСЬМА (prompts/letter.md):',
    '```',
    letterPromptText,
    '```',
    '',
    `ЗАМЕЧАНИЯ ВЛАДЕЛЬЦА (${rows.length}):`,
    ...items,
  ].join('\n');
}
