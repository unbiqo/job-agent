import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectForLimit, sendEligibility } from '../src/lib/selection';

const c = (id: string, score: number, published: string) => ({
  vacancy_id: id,
  score,
  published_at: published,
});

test('сортировка: скор DESC, при равном скоре свежие выигрывают', () => {
  const res = selectForLimit(
    [
      c('old9', 9, '2026-07-18T00:00:00Z'),
      c('fresh9', 9, '2026-07-21T00:00:00Z'),
      c('ten', 10, '2026-07-15T00:00:00Z'),
      c('seven', 7, '2026-07-21T00:00:00Z'),
    ],
    3,
  );
  assert.deepEqual(
    res.map((x) => x.vacancy_id),
    ['ten', 'fresh9', 'old9'],
  );
});

test('порог важнее лимита: кандидатов меньше N — отправляем сколько есть', () => {
  const res = selectForLimit([c('a', 8, '2026-07-21T00:00:00Z')], 10);
  assert.equal(res.length, 1);
});

test('нулевые и отрицательные слоты — пусто (дневной лимит исчерпан)', () => {
  const pool = [c('a', 9, '2026-07-21T00:00:00Z')];
  assert.equal(selectForLimit(pool, 0).length, 0);
  assert.equal(selectForLimit(pool, -2).length, 0);
});

test('sendEligibility: старая вакансия и has_test не проходят', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.equal(sendEligibility({ published_at: '2026-07-21T00:00:00Z', has_test: false }, 14, now).ok, true);
  assert.equal(sendEligibility({ published_at: '2026-07-01T00:00:00Z', has_test: false }, 14, now).ok, false);
  assert.equal(sendEligibility({ published_at: '2026-07-21T00:00:00Z', has_test: true }, 14, now).ok, false);
});
