import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * ЖЁСТКОЕ ОГРАНИЧЕНИЕ ТЗ (задача 3): голден-сет — тестовый набор, не обучающий.
 * Скорер и генератор писем не имеют доступа к evals/: ни импортом, ни чтением
 * файла, ни few-shot вставкой в промпт. Проверяем исходники и сами промпты.
 */
const SCORING_PATH_FILES = [
  'src/lib/scoring.ts',
  'src/lib/scorer.ts',
  'src/lib/letters.ts',
  'src/lib/prompts.ts',
  'src/lib/profile.ts',
  'prompts/scoring.md',
  'prompts/letter.md',
];

test('скоринг и письма не ссылаются на голден/evals (изоляция тестового набора)', () => {
  for (const file of SCORING_PATH_FILES) {
    const src = readFileSync(file, 'utf-8').toLowerCase();
    assert.ok(!src.includes('golden'), `${file} не должен упоминать голден-сет`);
    assert.ok(!/evals[\\/]/.test(src), `${file} не должен читать директорию evals/`);
  }
  // few-shot запрещён именно из голдена; эталоны стиля (задача 9) — легальны, но только
  // для писем: в скоринге few-shot не бывает вовсе
  for (const file of ['src/lib/scoring.ts', 'src/lib/scorer.ts', 'prompts/scoring.md']) {
    const src = readFileSync(file, 'utf-8').toLowerCase();
    assert.ok(!src.includes('few-shot'), `${file}: скоринг без few-shot`);
  }
});

test('scoring.ts не импортирует модули голдена (labels/evals)', () => {
  const src = readFileSync('src/lib/scoring.ts', 'utf-8');
  assert.ok(!src.includes("from './labels'"));
  assert.ok(!src.includes("from './evals'"));
  const scorer = readFileSync('src/lib/scorer.ts', 'utf-8');
  assert.ok(!scorer.includes("from './labels'"));
  assert.ok(!scorer.includes("from './evals'"));
});

// Ограничение задачи 9: правки писем и эталоны влияют ТОЛЬКО на промпт письма
test('скоринг никогда не видит letter_feedback/curated_examples/эталоны стиля', () => {
  for (const file of ['src/lib/scoring.ts', 'src/lib/scorer.ts', 'prompts/scoring.md']) {
    const src = readFileSync(file, 'utf-8').toLowerCase();
    assert.ok(!src.includes('letter_feedback'), `${file}: без доступа к логу правок`);
    assert.ok(!src.includes('curated'), `${file}: без доступа к эталонам`);
    assert.ok(!src.includes('style_example'), `${file}: без few-shot стиля`);
    assert.ok(!src.includes("from './feedback'"), `${file}: без импорта feedback`);
  }
});
