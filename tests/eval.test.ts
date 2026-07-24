import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeEvalMetrics, formatEvalReport, predictedLabel, type EvalRow } from '../src/lib/evals';
import type { VacancyLabel } from '../src/lib/labels';

const r = (human: VacancyLabel, predicted: VacancyLabel) => ({ human, predicted });

test('пустой набор: метрики не считаются, sufficient=false (n=0)', () => {
  const m = computeEvalMetrics([], 5);
  assert.equal(m.n, 0);
  assert.equal(m.sufficient, false);
  assert.equal(m.precision, null);
  assert.equal(m.recall, null);
  assert.equal(m.accuracy, null);
});

test('маленький набор (n=3 < 5): «недостаточно данных», метрики null', () => {
  const m = computeEvalMetrics([r('relevant', 'relevant'), r('relevant', 'irrelevant'), r('irrelevant', 'relevant')], 5);
  assert.equal(m.n, 3);
  assert.equal(m.sufficient, false);
  assert.equal(m.accuracy, null);
});

test('нормальный набор (n=6): precision/recall/accuracy считаются верно', () => {
  const rows = [
    r('relevant', 'relevant'), // tp
    r('relevant', 'relevant'), // tp
    r('irrelevant', 'relevant'), // fp
    r('relevant', 'irrelevant'), // fn
    r('irrelevant', 'irrelevant'), // tn
    r('irrelevant', 'irrelevant'), // tn
  ];
  const m = computeEvalMetrics(rows, 5);
  assert.equal(m.sufficient, true);
  assert.deepEqual([m.tp, m.fp, m.fn, m.tn], [2, 1, 1, 2]);
  assert.ok(Math.abs((m.precision as number) - 2 / 3) < 1e-9);
  assert.ok(Math.abs((m.recall as number) - 2 / 3) < 1e-9);
  assert.ok(Math.abs((m.accuracy as number) - 4 / 6) < 1e-9);
});

test('все предсказания негативные: precision=null (нет деления на ноль)', () => {
  const rows = Array.from({ length: 5 }, () => r('relevant', 'irrelevant'));
  const m = computeEvalMetrics(rows, 5);
  assert.equal(m.precision, null);
  assert.equal(m.recall, 0);
});

test('predictedLabel: relevant при score ≥ порога', () => {
  assert.equal(predictedLabel(7, 7), 'relevant');
  assert.equal(predictedLabel(6, 7), 'irrelevant');
  assert.equal(predictedLabel(10, 7), 'relevant');
});

test('отчёт: расхождения помечены, при n<5 явное «Недостаточно данных»', () => {
  const rows: EvalRow[] = [
    { vacancy_id: '1', title: 'A', human: 'relevant', score: 8, predicted: 'relevant', match: true },
    { vacancy_id: '2', title: 'B', human: 'relevant', score: 4, predicted: 'irrelevant', match: false },
  ];
  const report = formatEvalReport({
    rows,
    metrics: computeEvalMetrics(rows, 5),
    threshold: 7,
    promptFile: 'prompts/scoring.md',
    promptVersion: 1,
    model: 'test-model',
  });
  assert.ok(report.includes('Недостаточно данных, n=2'));
  assert.ok(report.includes('РАСХОЖДЕНИЕ'));
  assert.ok(report.includes('prompts/scoring.md'));
  assert.ok(report.includes('v1'));
});
