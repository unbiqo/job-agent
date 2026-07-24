export interface SalaryJson {
  from?: number | null;
  to?: number | null;
  currency?: string | null;
  gross?: boolean | null;
}

export interface VacancyRow {
  id: string;
  user_id: string;
  title: string;
  employer: string | null;
  salary: SalaryJson | null;
  area: string | null;
  published_at: string | null;
  description: string | null;
  key_skills: string[] | null;
  has_test: boolean | null;
  raw: Record<string, unknown> | null;
  first_seen_at: string;
}

export interface EvaluationRow {
  vacancy_id: string;
  user_id: string;
  prefilter: string | null; // passed | excluded:<причина>
  score: number | null;
  verdict: string | null;
  reasons: string[] | null;
  red_flags: string[] | null;
  resume_version: string | null;
  letter_hook: string | null;
  created_at: string;
}

export interface LetterRow {
  vacancy_id: string;
  user_id: string;
  text: string;
  version: number;
  created_at: string;
  // слой качества (задача 4): письмо дважды не прошло валидатор → ручная проверка
  needs_review?: boolean;
}

export type ApplicationStatus =
  | 'queued'
  | 'sent'
  | 'vetoed'
  | 'failed'
  | 'viewed'
  | 'invited'
  | 'rejected'
  | 'offer';

export interface ApplicationRow {
  vacancy_id: string;
  user_id: string;
  status: ApplicationStatus;
  queued_at: string | null;
  sent_at: string | null;
  response_at: string | null;
  error: string | null;
  tg_message_id: number | null;
  // v1.1: отклик подтверждён вручную (режим NO_OAUTH/FALLBACK, кнопка «✅ Я откликнулся»)
  manual?: boolean;
  // v1.1: момент последнего опроса статуса (3-дневный опрос ручных откликов)
  polled_at?: string | null;
}

export interface ScoreResult {
  score: number;
  verdict: 'strong' | 'partial' | 'no';
  reasons: string[];
  red_flags: string[];
  resume_version: string;
  letter_hook: string;
}

export interface RunStats {
  collected: number;
  new: number;
  excluded: number;
  scored: number;
  above_threshold: number;
  lettered: number;
  letters_rejected: number;
  queued: number;
  sent: number;
  failed: number;
  manual_required: number;
  sync_updates: number;
  errors: string[];
  // v1.1/v1.2: режим прогона (FULL|NO_OAUTH|FALLBACK) и вид прогона (main|delta)
  mode?: string;
  kind?: string;
  // слой качества: лог LLM-вызовов прогона (prompt_file/prompt_version/model/cost)
  llm_calls?: unknown[];
}

export function emptyRunStats(): RunStats {
  return {
    collected: 0,
    new: 0,
    excluded: 0,
    scored: 0,
    above_threshold: 0,
    lettered: 0,
    letters_rejected: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    manual_required: 0,
    sync_updates: 0,
    errors: [],
  };
}
