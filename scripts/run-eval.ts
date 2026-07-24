import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evalsCfg, loadFileConfig } from '../src/lib/config';
import { getDb } from '../src/lib/db';
import { computeEvalMetrics, formatEvalReport, predictedLabel, type EvalRow } from '../src/lib/evals';
import type { GoldenEntry } from '../src/lib/labels';
import { loadPrompt } from '../src/lib/prompts';
import { loadProfile, loadProfileSmart, type Profile } from '../src/lib/profile';
import { createScorer } from '../src/lib/scorer';
import type { VacancyRow } from '../src/lib/types';
import { errorMessage } from '../src/lib/util';

/**
 * npm run eval — регрессионный прогон ТЕКУЩЕГО scoring-промпта по голден-сету.
 * Голден — тестовый набор: он подаётся скореру как обычные вакансии, по одной;
 * ни сам голден, ни метки в промпт НЕ попадают (few-shot запрещён ТЗ).
 * Отчёт: консоль + evals/reports/<timestamp>.md.
 */
async function loadEvalProfile(): Promise<Profile> {
  const cfg = loadFileConfig();
  try {
    return await loadProfileSmart(getDb(), cfg);
  } catch {
    // без Supabase env падаем на локальные файлы профиля
    return loadProfile(cfg);
  }
}

async function main() {
  const cfg = loadFileConfig();
  const e = evalsCfg(cfg);
  const goldenPath = path.resolve(e.golden_path);
  const golden: GoldenEntry[] = existsSync(goldenPath)
    ? (JSON.parse(readFileSync(goldenPath, 'utf-8')) as GoldenEntry[])
    : [];

  console.log(`Голден-сет: ${e.golden_path}, n=${golden.length}`);
  if (golden.length === 0) {
    console.log('Недостаточно данных, n=0 — размечайте вакансии кнопками 👍/👎 и выполните npm run golden:export.');
    return;
  }
  if (golden.length < e.min_set_size) {
    console.log(`Недостаточно данных, n=${golden.length} — метрики считаются при n ≥ ${e.min_set_size}. Прогоняю без метрик.`);
  }

  const profile = await loadEvalProfile();
  const scorer = createScorer(cfg, profile);
  const prompt = loadPrompt(cfg, 'scoring');
  const threshold = cfg.scoring.threshold;

  const rows: EvalRow[] = [];
  for (const [i, g] of golden.entries()) {
    const v: VacancyRow = {
      id: g.vacancy_id,
      user_id: '',
      title: g.title,
      employer: g.employer,
      salary: g.salary,
      area: null,
      published_at: null,
      description: g.description,
      key_skills: g.key_skills,
      has_test: false,
      raw: {},
      first_seen_at: '',
    };
    process.stdout.write(`[${i + 1}/${golden.length}] ${g.title.slice(0, 60)} … `);
    try {
      const scored = await scorer.score(v);
      const predicted = predictedLabel(scored.result.score, threshold);
      rows.push({
        vacancy_id: g.vacancy_id,
        title: g.title,
        human: g.label,
        score: scored.result.score,
        predicted,
        match: predicted === g.label,
      });
      console.log(`score=${scored.result.score} (${predicted}${predicted === g.label ? ', ✓' : ', ✗'})`);
    } catch (err) {
      rows.push({
        vacancy_id: g.vacancy_id,
        title: g.title,
        human: g.label,
        score: null,
        predicted: 'irrelevant',
        match: false,
        error: errorMessage(err),
      });
      console.log('ошибка: ' + errorMessage(err));
    }
  }

  const scoredRows = rows.filter((r) => !r.error);
  const metrics = computeEvalMetrics(scoredRows, e.min_set_size);
  const report = formatEvalReport({
    rows,
    metrics,
    threshold,
    promptFile: prompt.file,
    promptVersion: prompt.version,
    model: scorer.model,
  });

  mkdirSync(path.resolve(e.reports_dir), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(e.reports_dir, `eval-${ts}.md`);
  writeFileSync(path.resolve(reportPath), report, 'utf-8');

  console.log('\n' + report);
  console.log(`Отчёт: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
