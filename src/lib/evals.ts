import type { VacancyLabel } from './labels';

/**
 * Задача 3 слоя качества: регрессионный eval скоринга по голден-сету.
 * ЖЁСТКОЕ ОГРАНИЧЕНИЕ (ТЗ): голден-сет — ТЕСТОВЫЙ набор. Он никогда не попадает
 * в промпт скорера или писем, никакого few-shot из него. Скорер импортируется
 * как чёрный ящик и получает только вакансию + профиль.
 */
export interface EvalRow {
  vacancy_id: string;
  title: string;
  human: VacancyLabel;
  score: number | null;
  predicted: VacancyLabel;
  match: boolean;
  error?: string;
}

/** relevant = score ≥ порога (тот же порог, что решает про письмо в пайплайне). */
export function predictedLabel(score: number, threshold: number): VacancyLabel {
  return score >= threshold ? 'relevant' : 'irrelevant';
}

export interface EvalMetrics {
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  accuracy: number | null;
  /** false = «недостаточно данных, n=X» (n < min_set_size). */
  sufficient: boolean;
}

export function computeEvalMetrics(
  rows: { human: VacancyLabel; predicted: VacancyLabel }[],
  minSetSize = 5,
): EvalMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of rows) {
    if (r.predicted === 'relevant' && r.human === 'relevant') tp++;
    else if (r.predicted === 'relevant' && r.human === 'irrelevant') fp++;
    else if (r.predicted === 'irrelevant' && r.human === 'relevant') fn++;
    else tn++;
  }
  const n = rows.length;
  const sufficient = n >= minSetSize;
  return {
    n,
    tp,
    fp,
    fn,
    tn,
    precision: sufficient && tp + fp > 0 ? tp / (tp + fp) : null,
    recall: sufficient && tp + fn > 0 ? tp / (tp + fn) : null,
    accuracy: sufficient && n > 0 ? (tp + tn) / n : null,
    sufficient,
  };
}

const fmtPct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const mark = { relevant: '👍', irrelevant: '👎' } as const;

/** Markdown-отчёт: сводка + таблица (вакансия, моя метка, score, вердикт, расхождение). */
export function formatEvalReport(opts: {
  rows: EvalRow[];
  metrics: EvalMetrics;
  threshold: number;
  promptFile: string;
  promptVersion: number;
  model: string;
  generatedAt?: Date;
}): string {
  const { rows, metrics: m } = opts;
  const lines: string[] = [
    `# Eval скоринга — ${(opts.generatedAt ?? new Date()).toISOString()}`,
    '',
    `- Промпт: \`${opts.promptFile}\` v${opts.promptVersion}`,
    `- Модель: \`${opts.model}\` · порог релевантности: ${opts.threshold}`,
    `- Голден-сет: n=${m.n}`,
    '',
  ];
  if (!m.sufficient) {
    lines.push(`**Недостаточно данных, n=${m.n}** — метрики считаются при n ≥ 5. Размечайте вакансии кнопками 👍/👎.`);
    lines.push('');
  } else {
    lines.push(
      `| Метрика | Значение |`,
      `|---|---|`,
      `| Precision | ${fmtPct(m.precision)} |`,
      `| Recall | ${fmtPct(m.recall)} |`,
      `| Accuracy | ${fmtPct(m.accuracy)} |`,
      `| TP / FP / FN / TN | ${m.tp} / ${m.fp} / ${m.fn} / ${m.tn} |`,
      '',
    );
  }
  if (rows.length) {
    lines.push(
      `| Вакансия | Моя метка | Score | Вердикт скорера | Совпадение |`,
      `|---|---|---|---|---|`,
      ...rows.map(
        (r) =>
          `| ${r.title.replace(/\|/g, '/')} | ${mark[r.human]} ${r.human} | ${r.score ?? '—'} | ${mark[r.predicted]} ${r.predicted} | ${r.error ? `⚠️ ${r.error}` : r.match ? '✓' : '✗ РАСХОЖДЕНИЕ'} |`,
      ),
      '',
    );
    const mismatches = rows.filter((r) => !r.match && !r.error);
    if (mismatches.length) {
      lines.push(`## Расхождения (${mismatches.length})`, '');
      for (const r of mismatches) {
        lines.push(`- **${r.title}**: моя метка ${r.human}, скорер дал ${r.score} (${r.predicted})`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
