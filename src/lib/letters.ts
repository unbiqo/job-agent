import type { AppConfig } from './config';
import { letterTaskCfg } from './config';
import { billedCost } from './cost';
import { buildStyleExamplesBlock } from './feedback';
import type { Profile } from './profile';
import { profileFactsForLetter } from './profile';
import { loadPrompt, renderPrompt, type PromptFile } from './prompts';
import type { EvaluationRow, VacancyRow } from './types';
import type { LLMClient, LLMUsage } from './llm/client';
import { detectLanguage } from './util';
import {
  formatViolations,
  letterValidationCfg,
  validateLetter,
  type LetterViolation,
} from './validate-letter';

// Обратная совместимость: guardrail-проверка фактов живёт в validate-letter.ts
export { validateLetterFacts } from './validate-letter';

export interface GeneratedLetter {
  text: string;
  /** true = обе попытки не прошли валидатор → письмо требует ручной проверки. */
  needsReview: boolean;
  violations: LetterViolation[];
  usage: LLMUsage;
  prompt: Pick<PromptFile, 'file' | 'version'>;
}

/**
 * Генерация письма (промпт prompts/letter.md, раздел 7.2 ТЗ) с детерминированной
 * валидацией (задача 4): при провале — одна автоматическая регенерация с указанием
 * нарушения; при повторном провале возвращаем текст с needsReview=true.
 */
export async function generateLetter(
  llm: LLMClient,
  cfg: AppConfig,
  profile: Profile,
  v: VacancyRow,
  ev: Pick<EvaluationRow, 'resume_version' | 'letter_hook' | 'red_flags'>,
  styleExamples: string[] = [],
): Promise<GeneratedLetter> {
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, billedInputTokens: 0, billedOutputTokens: 0 };
  const prompt = loadPrompt(cfg, 'letter');
  const system = renderPrompt(prompt.text, { tone: cfg.letters.tone, max_chars: cfg.letters.max_chars });
  const price = letterTaskCfg(cfg);
  const rules = letterValidationCfg(cfg);

  const vacancyText = [v.title, v.employer ?? '', v.description ?? ''].join('\n');
  const language = cfg.letters.language === 'auto' ? detectLanguage(vacancyText) : cfg.letters.language;
  const facts = profileFactsForLetter(profile, ev.resume_version ?? '');
  // задача 9: эталоны стиля (⭐) — few-shot ТОЛЬКО в промпт письма, скоринг их не видит
  const examplesBlock = buildStyleExamplesBlock(styleExamples);
  const baseUser = [
    `PROFILE_FACTS:\n${JSON.stringify(facts, null, 1)}`,
    ...(examplesBlock ? [examplesBlock] : []),
    `VACANCY:\n${JSON.stringify({ title: v.title, employer: v.employer, description: (v.description ?? '').slice(0, 6000) }, null, 1)}`,
    `letter_hook: ${ev.letter_hook ?? ''}`,
    `red_flags: ${JSON.stringify(ev.red_flags ?? [])}`,
    `Язык письма: ${language}`,
  ].join('\n\n');

  let lastText = '';
  let lastViolations: LetterViolation[] = [];
  let feedback = '';
  // Попытка 0 + ровно одна регенерация (задача 4)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.generate({
      system,
      user: feedback ? `${baseUser}\n\nЗАМЕЧАНИЯ К ПРЕДЫДУЩЕЙ ВЕРСИИ (исправь):\n${feedback}` : baseUser,
      temperature: 0.6,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.billedInputTokens += res.usage.billedInputTokens;
    usage.billedOutputTokens += res.usage.billedOutputTokens;
    console.log(
      `[llm] task=letter prompt=${prompt.file} v${prompt.version} model=${llm.model} in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${billedCost(res.usage, price).toFixed(6)} attempt=${attempt + 1}`,
    );

    lastText = res.text.trim();
    lastViolations = validateLetter(lastText, {
      maxChars: cfg.letters.max_chars,
      bannedPhrases: rules.bannedPhrases,
      templateJunk: rules.templateJunk,
      corpus: profile.corpus,
      vacancyText,
    });
    if (lastViolations.length === 0) {
      return { text: lastText, needsReview: false, violations: [], usage, prompt };
    }
    feedback = 'Исправь нарушения (факты бери ТОЛЬКО из PROFILE_FACTS):\n- ' + formatViolations(lastViolations);
  }
  return { text: lastText, needsReview: true, violations: lastViolations, usage, prompt };
}

/**
 * Задача 8: итеративная правка письма по замечанию владельца из Telegram.
 * Промпт prompts/letter-revise.md: «измени только указанное, сохрани остальное,
 * соблюдай все правила письма». Результат — через тот же валидатор (задача 4),
 * с одной автоматической регенерацией при провале.
 */
export async function reviseLetter(
  llm: LLMClient,
  cfg: AppConfig,
  profile: Profile,
  v: VacancyRow,
  resumeVersion: string | null,
  currentText: string,
  feedbackText: string,
): Promise<GeneratedLetter> {
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, billedInputTokens: 0, billedOutputTokens: 0 };
  const prompt = loadPrompt(cfg, 'letter-revise');
  const system = renderPrompt(prompt.text, { tone: cfg.letters.tone, max_chars: cfg.letters.max_chars });
  const price = letterTaskCfg(cfg);
  const rules = letterValidationCfg(cfg);
  const vacancyText = [v.title, v.employer ?? '', v.description ?? ''].join('\n');
  const facts = profileFactsForLetter(profile, resumeVersion ?? '');

  const baseUser = [
    `PROFILE_FACTS:\n${JSON.stringify(facts, null, 1)}`,
    `VACANCY: ${v.title} @ ${v.employer ?? '—'}`,
    `ТЕКУЩЕЕ ПИСЬМО:\n${currentText}`,
    `ПРАВКА ВЛАДЕЛЬЦА (измени только это):\n${feedbackText}`,
  ].join('\n\n');

  let lastText = currentText;
  let lastViolations: import('./validate-letter').LetterViolation[] = [];
  let retry = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.generate({
      system,
      user: retry ? `${baseUser}\n\nЗАМЕЧАНИЯ ВАЛИДАТОРА (исправь):\n${retry}` : baseUser,
      temperature: 0.4,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.billedInputTokens += res.usage.billedInputTokens;
    usage.billedOutputTokens += res.usage.billedOutputTokens;
    console.log(
      `[llm] task=letter-revise prompt=${prompt.file} v${prompt.version} model=${llm.model} in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${billedCost(res.usage, price).toFixed(6)} attempt=${attempt + 1}`,
    );

    lastText = res.text.trim();
    lastViolations = validateLetter(lastText, {
      maxChars: cfg.letters.max_chars,
      bannedPhrases: rules.bannedPhrases,
      templateJunk: rules.templateJunk,
      corpus: profile.corpus,
      vacancyText,
    });
    if (lastViolations.length === 0) {
      return { text: lastText, needsReview: false, violations: [], usage, prompt };
    }
    retry = formatViolations(lastViolations);
  }
  return { text: lastText, needsReview: true, violations: lastViolations, usage, prompt };
}
