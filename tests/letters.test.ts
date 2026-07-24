import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLetterFacts } from '../src/lib/letters';

const corpus = [
  'Проект JobAgent: https://github.com/user/job-agent — агент автопоиска работы.',
  'Сократил время на отклики с 2 часов до 10 минут в день.',
  'Опыт: 3 года, пет-проекты на LLM с 2024 года.',
].join('\n');

test('письмо только с фактами из корпуса — валидно', () => {
  const letter =
    'Здравствуйте! Построил JobAgent (https://github.com/user/job-agent), сократил рутину с 2 часов до 10 минут.';
  assert.deepEqual(validateLetterFacts(letter, corpus), []);
});

test('выдуманная ссылка — нарушение (guardrail 5)', () => {
  const letter = 'Моё демо: https://example.com/fake-demo';
  const v = validateLetterFacts(letter, corpus);
  assert.equal(v.length, 1);
  assert.match(v[0], /ссылка/);
});

test('выдуманная метрика-процент — нарушение', () => {
  const letter = 'Поднял конверсию на 47% в проде.';
  const v = validateLetterFacts(letter, corpus);
  assert.equal(v.length, 1);
  assert.match(v[0], /47/);
});

test('число из текста вакансии допускается', () => {
  const letter = 'Готов работать с бюджетом 300000 в месяц.';
  const v = validateLetterFacts(letter, corpus, 'Вилка: 300000–400000 руб.');
  assert.deepEqual(v, []);
});

test('число с разделителями находится в корпусе через компакт-сравнение', () => {
  const letter = 'С 2024 года строю LLM-продукты.';
  assert.deepEqual(validateLetterFacts(letter, corpus), []);
});
