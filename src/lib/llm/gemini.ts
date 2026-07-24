import { errorMessage, sleep } from '../util';
import type { LLMClient, LLMGenerateOptions, LLMResult } from './client';

/**
 * Gemini через REST generateContent. Free tier жёстко лимитирован по RPM,
 * поэтому есть собственный троттлинг (minIntervalMs) и backoff на 503 (временная
 * перегрузка). 429 (квота/rate limit) не ретраится на этом же ключе — такую ошибку
 * ловит MultiKeyGeminiClient ниже и сразу переключается на следующий ключ.
 */
export class GeminiClient implements LLMClient {
  private lastCallAt = 0;

  constructor(
    private apiKey: string,
    public model = 'gemini-2.5-flash',
    private minIntervalMs = 6000,
    /** true = ключ на биллинге (GEMINI_API_KEY3); только его токены попадают в стоимость. */
    private billed = false,
  ) {}

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  async generate(opts: LLMGenerateOptions): Promise<LLMResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    };
    if (opts.json) {
      generationConfig.responseMimeType = 'application/json';
      if (opts.schema) generationConfig.responseSchema = opts.schema;
    }
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts: [{ text: opts.user }] }],
      generationConfig,
    });

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body,
      });
      if (res.status === 503) {
        const text = await res.text().catch(() => '');
        if (attempt >= 4) throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
        await sleep(Math.min(60_000, 5000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) {
        throw new Error('Gemini вернула пустой ответ' + (cand?.finishReason ? ` (finishReason=${cand.finishReason})` : ''));
      }
      const um = data.usageMetadata ?? {};
      const inputTokens = um.promptTokenCount ?? 0;
      const outputTokens = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          // на бесплатном ключе billed = 0 → стоимость вызова $0
          billedInputTokens: this.billed ? inputTokens : 0,
          billedOutputTokens: this.billed ? outputTokens : 0,
        },
      };
    }
  }
}

/**
 * Несколько API-ключей с приоритетом: бесплатные (GEMINI_API_KEY, GEMINI_API_KEY2)
 * пробуются первыми, платный (GEMINI_API_KEY3) — только когда предыдущие не
 * сработали (квота исчерпана, ключ невалиден и т.п.).
 *
 * Индекс активного ключа не сбрасывается между вызовами generate() в рамках
 * одного процесса — чтобы не долбить уже исчерпанный бесплатный ключ на каждой
 * следующей вакансии. Новый прогон пайплайна — это новый процесс, поэтому он
 * снова начинает с первого (бесплатного) ключа: за это время квота могла обновиться.
 */
export class MultiKeyGeminiClient implements LLMClient {
  private idx = 0;
  model: string;

  /** Принимает готовые клиенты (по одному на ключ) — упрощает юнит-тестирование фолбэка без сети. */
  constructor(private clients: LLMClient[]) {
    if (!clients.length) throw new Error('Нужен хотя бы один ключ GEMINI_API_KEY');
    this.model = clients[0].model;
  }

  async generate(opts: LLMGenerateOptions): Promise<LLMResult> {
    for (; this.idx < this.clients.length; this.idx++) {
      try {
        return await this.clients[this.idx].generate(opts);
      } catch (e) {
        if (this.idx === this.clients.length - 1) throw e;
        console.error(`Gemini-ключ #${this.idx + 1} не сработал (${errorMessage(e)}), пробую следующий ключ`);
      }
    }
    throw new Error('Gemini: все ключи исчерпаны');
  }
}
