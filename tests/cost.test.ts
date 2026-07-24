import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addUsage, billedCost, emptyTally } from '../src/lib/cost';
import type { LLMUsage } from '../src/lib/llm/client';

const scoringPrice = { model: 'gemini-3.5-flash-lite', price_in_per_mtok: 0.3, price_out_per_mtok: 2.5 };
const lettersPrice = { model: 'gemini-3.5-flash', price_in_per_mtok: 1.5, price_out_per_mtok: 9.0 };

// usage от бесплатного ключа: billed*=0
const free = (inTok: number, outTok: number): LLMUsage => ({
  inputTokens: inTok,
  outputTokens: outTok,
  billedInputTokens: 0,
  billedOutputTokens: 0,
});
// usage от платного ключа (GEMINI_API_KEY3): billed*=total
const paid = (inTok: number, outTok: number): LLMUsage => ({
  inputTokens: inTok,
  outputTokens: outTok,
  billedInputTokens: inTok,
  billedOutputTokens: outTok,
});

// Ключевая проверка требования: на бесплатных ключах стоимость строго $0
test('бесплатный ключ (billed=0): реальные токены есть, но стоимость $0', () => {
  const tally = emptyTally();
  addUsage(tally, free(1_000_000, 1_000_000), lettersPrice, { task: 'letter' });
  assert.equal(tally.in, 1_000_000, 'токены учитываются как реальные');
  assert.equal(tally.out, 1_000_000);
  assert.equal(tally.costUsd, 0, 'но денег на free tier не потрачено');
  assert.equal(tally.calls[0].cost_usd, 0);
  assert.equal(tally.calls[0].billed_tokens_in, 0);
});

test('платный ключ (billed=total): стоимость по прайсу', () => {
  const tally = emptyTally();
  addUsage(tally, paid(1_000_000, 1_000_000), scoringPrice);
  assert.equal(tally.costUsd, 0.3 + 2.5);
});

test('billedCost: только billed-токены влияют на цену', () => {
  assert.equal(billedCost(free(5_000_000, 5_000_000), lettersPrice), 0);
  assert.equal(billedCost(paid(1_000_000, 0), lettersPrice), 1.5);
});

test('смешанный прогон: часть на free, часть на платном — платим только за платное', () => {
  const tally = emptyTally();
  addUsage(tally, free(2_000_000, 500_000), scoringPrice); // $0
  addUsage(tally, paid(100_000, 100_000), lettersPrice); // 0.15 + 0.9
  assert.equal(tally.in, 2_100_000);
  assert.equal(tally.out, 600_000);
  assert.ok(Math.abs(tally.costUsd - (0.15 + 0.9)) < 1e-9);
});

test('нулевые токены не дают стоимости', () => {
  const tally = emptyTally();
  addUsage(tally, paid(0, 0), lettersPrice);
  assert.equal(tally.costUsd, 0);
});
