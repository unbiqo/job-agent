import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLetter, type ValidateLetterOptions } from '../src/lib/validate-letter';

const corpus = [
  'Проект JobAgent: https://github.com/user/job-agent — агент автопоиска работы.',
  'Сократил время на отклики с 2 часов до 10 минут в день.',
].join('\n');

const opts: ValidateLetterOptions = {
  maxChars: 200,
  bannedPhrases: ['вайбкодинг'],
  templateJunk: ['как искусственный интеллект', 'я большой языковой модел'],
  corpus,
  vacancyText: 'Вилка: 300000 руб.',
};

const rules = (letter: string, o = opts) => validateLetter(letter, o).map((v) => v.rule);

test('валидное письмо проходит все правила', () => {
  assert.deepEqual(rules('Построил JobAgent (https://github.com/user/job-agent), готов обсудить.'), []);
});

test('правило length: письмо длиннее лимита', () => {
  assert.deepEqual(rules('х'.repeat(201)), ['length']);
});

test('правило banned_phrase: стоп-фраза из настроек (регистронезависимо)', () => {
  assert.deepEqual(rules('Практикую ВайбКодинг каждый день.'), ['banned_phrase']);
});

test('правило template_junk: шаблонный LLM-мусор', () => {
  assert.deepEqual(rules('Как искусственный интеллект, я рекомендую себя.'), ['template_junk']);
  assert.deepEqual(rules('Я большой языковой модель и умею писать.'), ['template_junk']);
});

test('правило fact_check: выдуманная ссылка и метрика не из KB', () => {
  assert.deepEqual(rules('Моё демо: https://example.com/fake'), ['fact_check']);
  assert.deepEqual(rules('Поднял конверсию на 47%'), ['fact_check']);
});

test('fact_check: число из текста вакансии допускается', () => {
  assert.deepEqual(rules('Ожидания: 300000 руб.'), []);
});

test('несколько нарушений сразу — все в списке', () => {
  const found = rules('Как искусственный интеллект, применяю вайбкодинг: https://example.com/fake');
  assert.deepEqual([...found].sort(), ['banned_phrase', 'fact_check', 'template_junk']);
});

test('punctuation: em dash is not allowed', () => {
  assert.deepEqual(rules('Здравствуйте — отвечаю коротко.'), ['punctuation']);
});

test('punctuation: bullet lists are not allowed', () => {
  assert.deepEqual(rules('Здравствуйте.\n- Python\n- SQL'), ['punctuation']);
});
