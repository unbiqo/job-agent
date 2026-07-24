import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withinActivityWindow } from '../src/lib/delta';
import { computeSlots, dedupeNewIds } from '../src/lib/selection';
import { parseVacancyInput, withFallbackFlag, FALLBACK_FLAG } from '../src/lib/vacancy-add';

// Тест #4: дельта-поллинг не создаёт дублей и расходует общий лимит
test('dedupeNewIds отбрасывает уже известные и внутренние дубли', () => {
  const known = new Set(['3']);
  assert.deepEqual(dedupeNewIds(['1', '2', '2', '3', '1'], known), ['1', '2']);
  assert.deepEqual(dedupeNewIds(['3'], known), []);
});

test('computeSlots: общий дневной лимит вычитает отправленное и очередь; не уходит в минус', () => {
  assert.equal(computeSlots(10, 3, 2), 5); // 10 − 3 отправлено − 2 в очереди
  assert.equal(computeSlots(10, 8, 5), 0); // лимит исчерпан — дельте слотов не остаётся
  assert.equal(computeSlots(10, 10, 0), 0);
});

test('withinActivityWindow: окно 06:00–01:00 МСК', () => {
  // Europe/Moscow = UTC+3
  assert.equal(withinActivityWindow('Europe/Moscow', new Date('2026-07-23T05:00:00Z')), true); // 08:00 МСК
  assert.equal(withinActivityWindow('Europe/Moscow', new Date('2026-07-23T21:30:00Z')), true); // 00:30 МСК
  assert.equal(withinActivityWindow('Europe/Moscow', new Date('2026-07-23T23:30:00Z')), false); // 02:30 МСК
  assert.equal(withinActivityWindow('Europe/Moscow', new Date('2026-07-23T02:00:00Z')), false); // 05:00 МСК
});

// Задача 3: /add помечает fallback-источник
test('parseVacancyInput: ссылка hh.ru/hh.kz → id; свободный текст → null', () => {
  assert.equal(parseVacancyInput('https://hh.ru/vacancy/98765432').hhId, '98765432');
  assert.equal(parseVacancyInput('https://hh.kz/vacancy/12345678?query=1').hhId, '12345678');
  assert.equal(parseVacancyInput('55555').hhId, '55555');
  assert.equal(parseVacancyInput('Ищем AI-инженера в стартап').hhId, null);
});

test('withFallbackFlag добавляет пометку неполноты данных без дублей', () => {
  assert.deepEqual(withFallbackFlag([]), [FALLBACK_FLAG]);
  assert.deepEqual(withFallbackFlag(['нет опыта с k8s']), ['нет опыта с k8s', FALLBACK_FLAG]);
  assert.deepEqual(withFallbackFlag([FALLBACK_FLAG]), [FALLBACK_FLAG]);
});
