import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFileConfig } from '../src/lib/config';
import { loadPrompt, renderPrompt } from '../src/lib/prompts';

const cfg = loadFileConfig();

test('loadPrompt: scoring.md читается, версия из шапки, шапка не попадает в текст', () => {
  const p = loadPrompt(cfg, 'scoring');
  assert.equal(p.file, 'prompts/scoring.md');
  assert.ok(p.version >= 1, 'version в шапке обязателен');
  assert.ok(p.text.includes('скоринговый движок'));
  assert.ok(!p.text.includes('---'), 'frontmatter-шапка должна быть отрезана');
  assert.ok(!p.text.includes('version:'));
});

test('loadPrompt: letter.md содержит плейсхолдеры, HTML-комментарии вырезаются', () => {
  const p = loadPrompt(cfg, 'letter');
  assert.ok(p.version >= 1);
  assert.ok(p.text.includes('{{max_chars}}'));
  assert.ok(p.text.includes('{{tone}}'));
  const onboarding = loadPrompt(cfg, 'onboarding');
  assert.ok(!onboarding.text.includes('<!--'), 'комментарии для людей не должны попадать в промпт');
});

test('renderPrompt подставляет значения, неизвестный ключ — пустая строка', () => {
  const out = renderPrompt('длина ≤ {{max_chars}}, тон: {{tone}}, x={{unknown}}', {
    max_chars: 1800,
    tone: 'уверенный',
  });
  assert.equal(out, 'длина ≤ 1800, тон: уверенный, x=');
});
