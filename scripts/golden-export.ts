import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evalsCfg, loadFileConfig } from '../src/lib/config';
import { getDb, OWNER_ID } from '../src/lib/db';
import { filterGoldenEligible, toGoldenEntry, type GoldenEntry, type LabelRow } from '../src/lib/labels';
import type { VacancyRow } from '../src/lib/types';
import { chunk } from '../src/lib/util';

/**
 * npm run golden:export [-- --days=N]
 * Выгружает метки 👍/👎 из таблицы labels в evals/golden.json — только те,
 * что старше N дней (дефолт из settings.json → evals.golden_min_age_days, 3):
 * отсекает случайные/импульсивные клики. Перезаписывает файл целиком (идемпотентно).
 */
async function main() {
  const cfg = loadFileConfig();
  const e = evalsCfg(cfg);
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const minAgeDays = daysArg ? Number(daysArg.split('=')[1]) : e.golden_min_age_days;

  const db = getDb();
  const { data, error } = await db
    .from('labels')
    .select('*')
    .eq('user_id', OWNER_ID)
    .eq('kind', 'vacancy')
    .order('labeled_at', { ascending: true });
  if (error && /find the table/i.test(error.message)) {
    console.log('Таблица labels не найдена — выполните supabase/migrations/003_quality_layer.sql в Supabase SQL Editor.');
    console.log('Экспортировать пока нечего: меток 0, golden.json не тронут.');
    return;
  }
  if (error) throw new Error('labels select: ' + error.message);
  const all = (data ?? []) as LabelRow[];
  const eligible = filterGoldenEligible(all, minAgeDays);

  const vacById = new Map<string, VacancyRow>();
  for (const part of chunk(eligible.map((l) => l.vacancy_id), 200)) {
    const { data: vs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vs ?? []) as VacancyRow[]) vacById.set(v.id, v);
  }

  const entries: GoldenEntry[] = [];
  for (const label of eligible) {
    const v = vacById.get(label.vacancy_id);
    if (v) entries.push(toGoldenEntry(label, v));
  }

  const outPath = path.resolve(e.golden_path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');

  console.log(`Голден-сет: ${entries.length} записей → ${e.golden_path}`);
  console.log(
    `Меток всего: ${all.length}; отсечено как свежие (< ${minAgeDays} дн.): ${all.length - eligible.length}`,
  );
  const likes = entries.filter((x) => x.label === 'relevant').length;
  console.log(`👍 ${likes} · 👎 ${entries.length - likes}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
