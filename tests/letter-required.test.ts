import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVacancyHtml } from '../src/lib/hh-scrape';
import { responseLetterRequired } from '../src/lib/vacancy-letter';

test('parseVacancyHtml: responseLetterRequired=false is preserved', () => {
  const html = [
    '<html><body>',
    '<h1 data-qa="vacancy-title">AI Engineer</h1>',
    '<div data-qa="vacancy-description">Build LLM systems</div>',
    '&#34;responseLetterRequired&#34;:false,',
    '&#34;vacancyId&#34;:999',
    '</body></html>',
  ].join('');
  const v = parseVacancyHtml('999', html);
  assert.equal(v.responseLetterRequired, false);
});

test('responseLetterRequired reads raw vacancy flags', () => {
  assert.equal(responseLetterRequired({ raw: { response_letter_required: false } }), false);
  assert.equal(responseLetterRequired({ raw: { responseLetterRequired: true } }), true);
  assert.equal(responseLetterRequired({ raw: {} }), null);
});
