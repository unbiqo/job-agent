import type { AppConfig } from './config';
import { scorerTaskCfg } from './config';
import { billedCost } from './cost';
import type { Profile } from './profile';
import { profileForScoring } from './profile';
import { loadPrompt, type PromptFile } from './prompts';
import type { ScoreResult, VacancyRow } from './types';
import { parseJsonLoose, type LLMClient, type LLMUsage } from './llm/client';

// Системный промпт скоринга (раздел 7.1 ТЗ) — версионируемый файл prompts/scoring.md.
// Вход строится ТОЛЬКО из профиля и вакансии — тестовый набор оценок сюда не попадает.

function scoringSchema(resumeVersions: string[]) {
  return {
    type: 'object',
    properties: {
      score: { type: 'integer' },
      verdict: { type: 'string', enum: ['strong', 'partial', 'no'] },
      reasons: { type: 'array', items: { type: 'string' } },
      red_flags: { type: 'array', items: { type: 'string' } },
      resume_version: { type: 'string', enum: resumeVersions },
      letter_hook: { type: 'string' },
    },
    required: ['score', 'verdict', 'reasons', 'red_flags', 'resume_version', 'letter_hook'],
  };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).slice(0, 6) : [];
}

export async function scoreVacancy(
  llm: LLMClient,
  cfg: AppConfig,
  profile: Profile,
  v: VacancyRow,
): Promise<{ result: ScoreResult; usage: LLMUsage; prompt: Pick<PromptFile, 'file' | 'version'> }> {
  const versions = Object.keys(cfg.scoring.resume_versions);
  const prompt = loadPrompt(cfg, 'scoring');
  const vacancy = {
    title: v.title,
    employer: v.employer,
    salary: v.salary,
    area: v.area,
    published_at: v.published_at,
    key_skills: v.key_skills,
    description: (v.description ?? '').slice(0, 6000),
  };
  const user = `PROFILE_JSON:\n${JSON.stringify(profileForScoring(cfg, profile), null, 1)}\n\nVACANCY:\n${JSON.stringify(vacancy, null, 1)}`;

  const res = await llm.generate({
    system: prompt.text,
    user,
    json: true,
    schema: scoringSchema(versions),
    temperature: 0.2,
  });
  const price = scorerTaskCfg(cfg);
  console.log(
    `[llm] task=scoring prompt=${prompt.file} v${prompt.version} model=${llm.model} in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${billedCost(res.usage, price).toFixed(6)}`,
  );
  const parsed = parseJsonLoose(res.text) as Partial<ScoreResult>;

  const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score ?? 0))));
  const verdict: ScoreResult['verdict'] =
    parsed.verdict === 'strong' || parsed.verdict === 'partial' || parsed.verdict === 'no'
      ? parsed.verdict
      : score >= 7
        ? 'strong'
        : score >= 5
          ? 'partial'
          : 'no';
  const resume_version =
    typeof parsed.resume_version === 'string' && versions.includes(parsed.resume_version)
      ? parsed.resume_version
      : versions[0];

  return {
    result: {
      score,
      verdict,
      reasons: asStringArray(parsed.reasons),
      red_flags: asStringArray(parsed.red_flags),
      resume_version,
      letter_hook: String(parsed.letter_hook ?? ''),
    },
    usage: res.usage,
    prompt: { file: prompt.file, version: prompt.version },
  };
}
