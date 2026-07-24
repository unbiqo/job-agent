import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evalsCfg, loadFileConfig } from '../src/lib/config';
import { getDb, OWNER_ID } from '../src/lib/db';
import type { LabelRow } from '../src/lib/labels';
import { createPatternAnalyzer, type LabeledVacancy } from '../src/lib/patterns';
import type { VacancyRow } from '../src/lib/types';
import { chunk } from '../src/lib/util';

/**
 * npm run stats:patterns — частотный анализ 👍 vs 👎 вакансий (задача 5).
 * Только отчёт: никаких автоматических изменений запросов/порогов/весов.
 */
async function main() {
  const cfg = loadFileConfig();
  const db = getDb();

  const { data, error } = await db.from('labels').select('*').eq('user_id', OWNER_ID).eq('kind', 'vacancy');
  if (error && /find the table/i.test(error.message)) {
    // холодный старт: таблица меток ещё не создана
    console.log('Таблица labels не найдена — выполните supabase/migrations/003_quality_layer.sql в Supabase SQL Editor.');
    console.log('Меток пока 0 — отчёт будет пустым. Размечайте вакансии кнопками 👍/👎 в Telegram.');
  } else if (error) {
    throw new Error('labels select: ' + error.message);
  }
  const labels = (data ?? []) as LabelRow[];

  const vacById = new Map<string, VacancyRow>();
  for (const part of chunk(labels.map((l) => l.vacancy_id), 200)) {
    const { data: vs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vs ?? []) as VacancyRow[]) vacById.set(v.id, v);
  }

  const items: LabeledVacancy[] = [];
  for (const l of labels) {
    const v = vacById.get(l.vacancy_id);
    if (!v || (l.label !== 'relevant' && l.label !== 'irrelevant')) continue;
    items.push({
      label: l.label,
      title: v.title,
      description: v.description,
      key_skills: v.key_skills,
      salary: v.salary,
      employer: v.employer,
    });
  }

  const report = createPatternAnalyzer(cfg).analyze(items);
  console.log(report.markdown);

  const e = evalsCfg(cfg);
  mkdirSync(path.resolve(e.reports_dir), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(e.reports_dir, `patterns-${ts}.md`);
  writeFileSync(path.resolve(reportPath), report.markdown, 'utf-8');
  console.log(`\nОтчёт: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
