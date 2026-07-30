import type { AppConfig } from '../config';
import { GeminiClient, MultiKeyGeminiClient } from './gemini';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Токены, реально обслуженные ПЛАТНЫМ ключом (GEMINI_API_KEY3). На бесплатных
   * ключах (free tier) = 0 → стоимость такого вызова $0. Именно из billed-токенов
   * считается cost, чтобы дайджест не показывал фантомные траты (см. cost.ts).
   */
  billedInputTokens: number;
  billedOutputTokens: number;
}

export interface LLMResult {
  text: string;
  usage: LLMUsage;
}

export interface LLMGenerateOptions {
  system: string;
  user: string;
  json?: boolean;
  schema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LLMClient {
  model: string;
  generate(opts: LLMGenerateOptions): Promise<LLMResult>;
}

export type LLMTask = 'scoring' | 'letters';

interface GeminiKey {
  key: string;
  /** true только для GEMINI_API_KEY3 — единственного ключа на биллинге. */
  billed: boolean;
}

/** GEMINI_API_KEY/2 — бесплатные (free tier, $0), пробуются первыми; GEMINI_API_KEY3 — платный фолбэк. */
function geminiApiKeys(): GeminiKey[] {
  return [
    { key: process.env.GEMINI_API_KEY?.trim(), billed: false },
    { key: process.env.GEMINI_API_KEY2?.trim(), billed: false },
    { key: process.env.GEMINI_API_KEY3?.trim(), billed: true },
  ].filter((k): k is GeminiKey => !!k.key);
}

/**
 * Абстракция провайдера (раздел 4 ТЗ): v0 — Gemini; добавление OpenAI-совместимых —
 * новая ветка тут. Модель выбирается по задаче: скоринг — дешёвая модель для
 * высокого объёма простых оценок, письма — модель уровнем выше ради качества.
 * Апгрейд модели под задачу — одна строка в config/settings.json, без правок кода.
 */
export function createLLM(cfg: AppConfig, task: LLMTask): LLMClient {
  switch (cfg.llm.provider) {
    case 'gemini': {
      const keys = geminiApiKeys();
      if (!keys.length) throw new Error('GEMINI_API_KEY обязателен (https://aistudio.google.com/apikey)');
      const model = task === 'scoring' ? cfg.llm.scorer_model : cfg.llm.letter_model;
      const clients = keys.map((k) => new GeminiClient(k.key, model, cfg.llm.min_interval_ms, k.billed));
      return new MultiKeyGeminiClient(clients);
    }
    default:
      throw new Error(`Неизвестный LLM-провайдер: ${cfg.llm.provider}`);
  }
}

export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('LLM вернула невалидный JSON: ' + text.slice(0, 200));
  }
}
