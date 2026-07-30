import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseRuDateText, parseSearchHtml, parseVacancyHtml } from '../src/lib/hh-scrape';

const searchHtml = readFileSync(path.join(__dirname, 'fixtures', 'hh_search.html'), 'utf-8');
const vacancyHtml = readFileSync(path.join(__dirname, 'fixtures', 'hh_vacancy.html'), 'utf-8');

test('serp: парсятся обе валидные карточки, битая пропускается', () => {
  const items = parseSearchHtml(searchHtml);
  assert.equal(items.length, 2);

  const first = items[0];
  assert.equal(first.id, '133191802');
  assert.equal(first.title, 'Менеджер по продажам (горячие лиды)');
  assert.match(first.url, /^https:\/\/hh\.ru\/vacancy\/133191802/);
  assert.equal(first.employer, 'Онлайн-школа Тетрика');
  assert.equal(first.area, 'Ростов-на-Дону');
  assert.ok(first.salaryText?.includes('150 000'));
  assert.ok(first.salaryText?.includes('₽'));
  // дата и зарплата — из встроенного JSON-состояния страницы
  assert.ok(first.publishedAt?.startsWith('2026-07-27T12:22:12'));
  assert.deepEqual(first.salary, { from: 150000, to: null, currency: 'RUR', gross: false });
  assert.equal(first.scheduleId, 'remote');

  const second = items[1];
  assert.equal(second.id, '135583370');
  assert.equal(second.title, 'Team Lead аналитики в Collection');
  assert.equal(second.employer, 'Банк Русский Стандарт');
  assert.equal(second.area, 'Москва, р-н Преображенское');
  assert.equal(second.salaryText, null); // зарплата не указана (noCompensation)
  assert.equal(second.salary, null);
});

test('serp: страница без карточек — понятная ошибка, а не тихий ноль', () => {
  assert.throws(() => parseSearchHtml('<html><body>капча</body></html>'), /разметка/i);
});

test('вакансия: основные поля страницы', () => {
  const v = parseVacancyHtml('133191802', vacancyHtml);
  assert.equal(v.title, 'Менеджер по продажам (горячие лиды)');
  assert.equal(v.employer, 'Онлайн-школа Тетрика');
  assert.ok(v.salaryText?.includes('150 000'));
  assert.deepEqual(v.salary, { from: 150000, to: null, currency: 'RUR', gross: false });
  assert.ok(v.description?.includes('Тетрика'));
  assert.ok(!v.description?.includes('<')); // HTML описания снят
  assert.equal(v.experience, '1–3 года');
  assert.ok(v.address?.includes('Ростов-на-Дону'));
  assert.ok(v.publishedAt?.startsWith('2026-07-27T12:22:12'));
  assert.equal(v.hasTest, false);
  assert.equal(v.remote, true);
  assert.deepEqual(v.keySkills, []); // у этой вакансии keySkills:null
});

test('вакансия: страница без заголовка — ошибка', () => {
  assert.throws(() => parseVacancyHtml('1', '<html><body>404</body></html>'), /vacancy-title/);
});

test('даты hh: «сегодня», «вчера», «4 августа»', () => {
  const now = new Date(Date.UTC(2026, 6, 27, 15, 30)); // 27 июля 2026
  assert.equal(parseRuDateText('сегодня', now), '2026-07-27T00:00:00.000Z');
  assert.equal(parseRuDateText('вчера', now), '2026-07-26T00:00:00.000Z');
  assert.equal(parseRuDateText('4 августа', now), '2025-08-04T00:00:00.000Z'); // месяц «в будущем» → прошлый год
  assert.equal(parseRuDateText('4 июля', now), '2026-07-04T00:00:00.000Z');
  assert.equal(parseRuDateText('31 декабря 2025', now), '2025-12-31T00:00:00.000Z'); // явный год
  assert.equal(parseRuDateText('какой-то текст', now), null);
});
