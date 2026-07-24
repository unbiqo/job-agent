import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualAppliedPatch, manualQueueRow } from '../src/lib/apply';
import { canSend } from '../src/lib/hh-health';
import { manualKeyboard, statusPollKeyboard } from '../src/lib/telegram';

// Тест #2: в NO_OAUTH POST /negotiations не вызывается, карточка содержит 4 кнопки
test('NO_OAUTH не отправляет автоматически (POST /negotiations не вызывается)', () => {
  // canSend — единственный гейт автоотправки в пайплайне; для NO_OAUTH он false,
  // значит выбирается ручная карточка, а не путь sendApplication → hh.apply.
  assert.equal(canSend('NO_OAUTH'), false);
  assert.equal(canSend('FALLBACK'), false);
  assert.equal(canSend('FULL'), true);
});

test('manualKeyboard: 4 кнопки действий (копировать/открыть/откликнулся/пропустить) + ряд меток 👍/👎', () => {
  const kb = manualKeyboard('12345');
  const buttons = kb.inline_keyboard.flat();
  // 4 кнопки ручного отклика (спека 3.6) + 2 метки релевантности (слой качества, задача 2)
  assert.equal(buttons.length, 6);
  assert.ok(buttons.some((b) => b.callback_data === 'copy:12345'));
  assert.ok(buttons.some((b) => b.url === 'https://hh.ru/vacancy/12345'));
  assert.ok(buttons.some((b) => b.callback_data === 'mark:12345'));
  assert.ok(buttons.some((b) => b.callback_data === 'skip:12345'));
  assert.ok(buttons.some((b) => b.callback_data === 'like:12345'));
  assert.ok(buttons.some((b) => b.callback_data === 'dislike:12345'));
});

// Тест #3: sent ставится только по кнопке подтверждения
test('ручная очередь ставит статус queued, а не sent', () => {
  const row = manualQueueRow('12345', 777);
  assert.equal(row.status, 'queued');
  assert.equal(row.tg_message_id, 777);
  assert.notEqual(row.status, 'sent');
});

test('sent + manual ставятся ТОЛЬКО патчем подтверждения «Я откликнулся»', () => {
  const patch = manualAppliedPatch();
  assert.equal(patch.status, 'sent');
  assert.equal(patch.manual, true);
  assert.ok(typeof patch.sent_at === 'string');
});

test('statusPollKeyboard содержит 4 варианта ответа опроса', () => {
  const kb = statusPollKeyboard('99');
  const buttons = kb.inline_keyboard.flat();
  assert.equal(buttons.length, 4);
  assert.deepEqual(
    buttons.map((b) => b.callback_data),
    ['st_viewed:99', 'st_invited:99', 'st_rejected:99', 'st_silence:99'],
  );
});
