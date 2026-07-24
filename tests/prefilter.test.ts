import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/lib/config';
import { prefilter } from '../src/lib/prefilter';

const cfg = {
  filters: {
    salary_min: 250_000,
    currency: 'RUR',
    formats: ['remote'],
    exclude_experience: ['moreThan6'],
    stop_words: ['только офис'],
    stop_companies: ['ООО Плохая Компания'],
    agency_markers: ['кадровое агентство'],
    max_vacancy_age_days: 14,
  },
} as AppConfig;

const now = new Date('2026-07-22T12:00:00Z');

function vacancy(overrides: Record<string, unknown> = {}) {
  return {
    title: 'AI-инженер',
    employer: 'Хорошая Компания',
    description: 'Строим RAG-пайплайны, работа удалённая.',
    salary: null,
    published_at: '2026-07-20T10:00:00Z',
    has_test: false,
    raw: { schedule: { id: 'remote' } },
    ...overrides,
  } as Parameters<typeof prefilter>[0];
}

test('свежая удалённая вакансия проходит', () => {
  assert.equal(prefilter(vacancy(), cfg, now).passed, true);
});

test('стоп-слово исключает', () => {
  const r = prefilter(vacancy({ description: 'у нас только офис, без удалёнки' }), cfg, now);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /стоп-слово/);
});

test('senior-опыт (moreThan6) исключается детерминированно', () => {
  const r = prefilter(vacancy({ raw: { schedule: { id: 'remote' }, experience: { id: 'moreThan6' } } }), cfg, now);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /опыт/);
});

test('не-удалёнка исключается при remote-настройке', () => {
  const r = prefilter(
    vacancy({ description: 'работа в офисе в Москве', raw: { schedule: { id: 'fullDay' } } }),
    cfg,
    now,
  );
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /формат/);
});

test('вакансия старше 14 дней исключается (guardrail 1)', () => {
  const r = prefilter(vacancy({ published_at: '2026-07-01T00:00:00Z' }), cfg, now);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /старше 14/);
});

test('has_test помечается как ручной отклик (guardrail 2)', () => {
  const r = prefilter(vacancy({ has_test: true }), cfg, now);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /has_test/);
});

test('зарплата ниже минимума в той же валюте исключается', () => {
  const r = prefilter(vacancy({ salary: { from: 100_000, to: 180_000, currency: 'RUR' } }), cfg, now);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /зарплата/);
});

test('зарплата в другой валюте не сравнивается — проходит', () => {
  const r = prefilter(vacancy({ salary: { from: 1000, to: 2000, currency: 'USD' } }), cfg, now);
  assert.equal(r.passed, true);
});

test('стоп-компания и агентство исключаются', () => {
  assert.equal(prefilter(vacancy({ employer: 'ООО Плохая Компания' }), cfg, now).passed, false);
  assert.equal(prefilter(vacancy({ employer: 'Первое Кадровое Агентство' }), cfg, now).passed, false);
});
