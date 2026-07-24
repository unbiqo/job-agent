import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { filterGoldenEligible, toGoldenEntry, type LabelRow } from '../src/lib/labels';
import type { VacancyRow } from '../src/lib/types';

const now = new Date('2026-07-23T12:00:00Z');
const label = (id: string, labeledAt: string): LabelRow => ({
  vacancy_id: id,
  user_id: 'u',
  kind: 'vacancy',
  label: 'relevant',
  score: 8,
  reasons: ['RAG совпадает'],
  labeled_at: labeledAt,
});

test('golden.json в репозитории стартует пустым (холодный старт)', () => {
  const golden = JSON.parse(readFileSync('evals/golden.json', 'utf-8'));
  assert.deepEqual(golden, []);
});

test('экспорт в голден: только метки старше N дней (отсекаем импульсивные клики)', () => {
  const rows = [
    label('old', '2026-07-19T12:00:00Z'), // 4 дня — проходит
    label('edge', '2026-07-20T12:00:00Z'), // ровно 3 дня — проходит
    label('fresh', '2026-07-22T11:00:00Z'), // 1 день — нет
    label('today', '2026-07-23T11:59:00Z'), // только что — нет
  ];
  const eligible = filterGoldenEligible(rows, 3, now);
  assert.deepEqual(
    eligible.map((r) => r.vacancy_id),
    ['old', 'edge'],
  );
});

test('фильтр с days=0 пропускает всё, битые даты отбрасываются', () => {
  const rows = [label('a', '2026-07-23T11:00:00Z'), label('bad', 'not-a-date')];
  assert.deepEqual(filterGoldenEligible(rows, 0, now).map((r) => r.vacancy_id), ['a']);
});

test('toGoldenEntry снапшотит вакансию + метку + оценку скорера на момент метки', () => {
  const v = {
    id: 'v1',
    title: 'AI-инженер',
    employer: 'Компания',
    salary: { from: 300000, currency: 'RUR' },
    key_skills: ['Python'],
    description: 'RAG и LLM',
  } as unknown as VacancyRow;
  const e = toGoldenEntry(label('v1', '2026-07-19T00:00:00Z'), v);
  assert.equal(e.vacancy_id, 'v1');
  assert.equal(e.label, 'relevant');
  assert.equal(e.score_at_label, 8);
  assert.deepEqual(e.reasons_at_label, ['RAG совпадает']);
  assert.equal(e.title, 'AI-инженер');
});
