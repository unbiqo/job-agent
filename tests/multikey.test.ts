import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LLMClient, LLMResult } from '../src/lib/llm/client';
import { MultiKeyGeminiClient } from '../src/lib/llm/gemini';

function fakeClient(model: string, behavior: (() => LLMResult) | 'throw'): LLMClient {
  return {
    model,
    async generate() {
      if (behavior === 'throw') throw new Error(`ключ ${model} недоступен`);
      return behavior();
    },
  };
}

const ok = (model: string): LLMResult => ({
  text: `ответ от ${model}`,
  usage: { inputTokens: 1, outputTokens: 1, billedInputTokens: 0, billedOutputTokens: 0 },
});

test('первый (бесплатный) ключ работает — остальные не трогаем', async () => {
  let secondCalled = false;
  const first = fakeClient('free1', () => ok('free1'));
  const second: LLMClient = {
    model: 'free2',
    async generate() {
      secondCalled = true;
      return ok('free2');
    },
  };
  const client = new MultiKeyGeminiClient([first, second]);
  const res = await client.generate({ system: 's', user: 'u' });
  assert.equal(res.text, 'ответ от free1');
  assert.equal(secondCalled, false);
});

test('первый ключ не сработал — переключается на второй (бесплатный)', async () => {
  const client = new MultiKeyGeminiClient([fakeClient('free1', 'throw'), fakeClient('free2', () => ok('free2'))]);
  const res = await client.generate({ system: 's', user: 'u' });
  assert.equal(res.text, 'ответ от free2');
});

test('оба бесплатных не сработали — фолбэк на платный третий ключ', async () => {
  const client = new MultiKeyGeminiClient([
    fakeClient('free1', 'throw'),
    fakeClient('free2', 'throw'),
    fakeClient('paid', () => ok('paid')),
  ]);
  const res = await client.generate({ system: 's', user: 'u' });
  assert.equal(res.text, 'ответ от paid');
});

test('индекс активного ключа персистентен между вызовами (не долбит исчерпанный free)', async () => {
  let free1Calls = 0;
  const free1: LLMClient = {
    model: 'free1',
    async generate() {
      free1Calls++;
      throw new Error('квота исчерпана');
    },
  };
  const paid = fakeClient('paid', () => ok('paid'));
  const client = new MultiKeyGeminiClient([free1, paid]);

  await client.generate({ system: 's', user: 'u' });
  await client.generate({ system: 's', user: 'u' });
  await client.generate({ system: 's', user: 'u' });

  assert.equal(free1Calls, 1); // после первого провала — сразу остаёмся на paid
});

test('все ключи исчерпаны — бросает ошибку последнего ключа', async () => {
  const client = new MultiKeyGeminiClient([fakeClient('free1', 'throw'), fakeClient('paid', 'throw')]);
  await assert.rejects(() => client.generate({ system: 's', user: 'u' }), /paid недоступен/);
});

test('без ключей — конструктор бросает сразу', () => {
  assert.throws(() => new MultiKeyGeminiClient([]), /хотя бы один ключ/);
});
