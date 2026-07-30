import { letterTaskCfg, type AppConfig } from './config';
import { billedCost } from './cost';
import type { LLMClient, LLMUsage } from './llm/client';
import type { Profile } from './profile';
import { profileFactsForLetter } from './profile';
import { loadPrompt, renderPrompt, type PromptFile } from './prompts';
import type { EvaluationRow, VacancyRow } from './types';
import { detectLanguage } from './util';
import { formatViolations, letterValidationCfg, validateLetter, type LetterViolation } from './validate-letter';

export { validateLetterFacts } from './validate-letter';

export interface GeneratedLetter {
  text: string;
  needsReview: boolean;
  violations: LetterViolation[];
  usage: LLMUsage;
  prompt: Pick<PromptFile, 'file' | 'version'>;
}

export async function generateLetter(
  llm: LLMClient,
  cfg: AppConfig,
  profile: Profile,
  v: VacancyRow,
  ev: Pick<EvaluationRow, 'resume_version' | 'letter_hook' | 'red_flags'>,
): Promise<GeneratedLetter> {
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, billedInputTokens: 0, billedOutputTokens: 0 };
  const prompt = loadPrompt(cfg, 'letter');
  const system = renderPrompt(prompt.text, { tone: cfg.letters.tone, max_chars: cfg.letters.max_chars });
  const price = letterTaskCfg(cfg);
  const rules = letterValidationCfg(cfg);

  const vacancyText = [v.title, v.employer ?? '', v.description ?? ''].join('\n');
  const language = cfg.letters.language === 'auto' ? detectLanguage(vacancyText) : cfg.letters.language;
  const facts = profileFactsForLetter(profile, ev.resume_version ?? '');
  const baseUser = [
    `PROFILE_FACTS:\n${JSON.stringify(facts, null, 1)}`,
    `VACANCY:\n${JSON.stringify(
      {
        title: v.title,
        employer: v.employer,
        description: (v.description ?? '').slice(0, 6000),
      },
      null,
      1,
    )}`,
    `letter_hook: ${ev.letter_hook ?? ''}`,
    `red_flags: ${JSON.stringify(ev.red_flags ?? [])}`,
    `Язык письма: ${language}`,
  ].join('\n\n');

  let lastText = '';
  let lastViolations: LetterViolation[] = [];
  let retry = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.generate({
      system,
      user: retry ? `${baseUser}\n\nИсправь эти нарушения, факты бери только из PROFILE_FACTS и VACANCY:\n- ${retry}` : baseUser,
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
    retry = formatViolations(lastViolations);
  }

  return { text: lastText, needsReview: true, violations: lastViolations, usage, prompt };
}
