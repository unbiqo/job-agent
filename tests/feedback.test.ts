import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDistillInput,
  buildStyleExamplesBlock,
  chooseStyleExamples,
  editModeForRounds,
  type FeedbackForDistill,
} from '../src/lib/feedback';

// Задача 8: максимум 3 LLM-раунда правок, дальше needs_manual
test('editModeForRounds: 0-2 раунда → revise, 3+ → manual', () => {
  assert.equal(editModeForRounds(0), 'revise');
  assert.equal(editModeForRounds(2), 'revise');
  assert.equal(editModeForRounds(3), 'manual');
  assert.equal(editModeForRounds(7), 'manual');
  assert.equal(editModeForRounds(1, 1), 'manual'); // кастомный лимит из конфига
});

// Задача 9: гейт few-shot эталонов
test('chooseStyleExamples: флаг off → пусто, даже при полном пуле', () => {
  assert.deepEqual(chooseStyleExamples(false, ['a', 'b', 'c', 'd']), []);
});

test('chooseStyleExamples: пул < 3 → пусто (включается только при ≥3 примерах)', () => {
  assert.deepEqual(chooseStyleExamples(true, ['a', 'b']), []);
});

test('chooseStyleExamples: флаг on и пул ≥ 3 → до 3 примеров', () => {
  assert.deepEqual(chooseStyleExamples(true, ['a', 'b', 'c', 'd']), ['a', 'b', 'c']);
  assert.deepEqual(chooseStyleExamples(true, ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('buildStyleExamplesBlock: пусто → пустая строка; примеры → блок с предупреждением про факты', () => {
  assert.equal(buildStyleExamplesBlock([]), '');
  const block = buildStyleExamplesBlock(['Письмо один', 'Письмо два']);
  assert.ok(block.includes('ПРИМЕРЫ СТИЛЯ'));
  assert.ok(block.includes('ТОЛЬКО из PROFILE_FACTS'), 'факты из примеров запрещены');
  assert.ok(block.includes('Письмо один'));
  assert.ok(block.includes('Пример 2:'));
});

// Задача 9: вход дистилляции
test('buildDistillInput: содержит промпт письма и замечания, длинные письма обрезаются', () => {
  const rows: FeedbackForDistill[] = [
    {
      feedback_text: 'убери канцелярит',
      original_text: 'х'.repeat(1000),
      revised_text: 'коротко',
      status: 'revised',
      created_at: '2026-07-20T10:00:00Z',
    },
    {
      feedback_text: 'добавь ссылку на GitHub',
      original_text: 'оригинал',
      revised_text: null,
      status: 'validation_failed',
      created_at: '2026-07-21T10:00:00Z',
    },
  ];
  const input = buildDistillInput(rows, 'СИСТЕМНЫЙ ПРОМПТ ПИСЬМА vX');
  assert.ok(input.includes('СИСТЕМНЫЙ ПРОМПТ ПИСЬМА vX'));
  assert.ok(input.includes('убери канцелярит'));
  assert.ok(input.includes('добавь ссылку на GitHub'));
  assert.ok(input.includes('ЗАМЕЧАНИЯ ВЛАДЕЛЬЦА (2)'));
  assert.ok(!input.includes('х'.repeat(500)), 'письмо длиной 1000 обрезано до ~400');
  assert.ok(input.includes('…'), 'маркер обрезки на месте');
  assert.ok(input.includes('(правка не применена)'));
});
