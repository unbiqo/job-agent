import type { AppConfig } from './config';
import { createLLM, type LLMClient, type LLMUsage } from './llm/client';
import type { Profile } from './profile';
import type { PromptFile } from './prompts';
import { scoreVacancy } from './scoring';
import type { ScoreResult, VacancyRow } from './types';

/**
 * Задача 6 слоя качества: скоринг за интерфейсом — реализацию можно заменить,
 * не переписывая пайплайн (pipeline/delta/eval работают только с Scorer).
 *
 * TODO(roadmap v2, ТЗ «слой качества» п.6): при 300+ метках сюда можно добавить
 * альтернативные реализации — ML-классификатор, LLM-as-judge, дообучение.
 * Сейчас НЕ реализовывать: никакого авто-обучения, только LLM-скоринг по промпту.
 */
export interface ScoredVacancy {
  result: ScoreResult;
  usage: LLMUsage;
  prompt: Pick<PromptFile, 'file' | 'version'>;
}

export interface Scorer {
  /** Идентификатор реализации — попадает в логи/отчёты eval. */
  readonly id: string;
  readonly model: string;
  score(v: VacancyRow): Promise<ScoredVacancy>;
}

export class LLMScorer implements Scorer {
  readonly id = 'llm';

  constructor(
    private llm: LLMClient,
    private cfg: AppConfig,
    private profile: Profile,
  ) {}

  get model(): string {
    return this.llm.model;
  }

  score(v: VacancyRow): Promise<ScoredVacancy> {
    return scoreVacancy(this.llm, this.cfg, this.profile, v);
  }
}

export function createScorer(cfg: AppConfig, profile: Profile): Scorer {
  return new LLMScorer(createLLM(cfg, 'scoring'), cfg, profile);
}
