import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OWNER_ID } from './db';

export interface ResumeVersionCfg {
  title: string;
  hh_resume_id: string;
  file: string;
}

export interface LLMTaskCfg {
  model: string;
  price_in_per_mtok: number;
  price_out_per_mtok: number;
}

export type SourceId = 'hh' | 'remoteok' | 'wwr';
export type RegionFilterKey = 'worldwide' | 'us' | 'canada' | 'uk' | 'europe' | 'latin_america' | 'asia' | 'unspecified';
export type JobTypeFilterKey = 'full_time' | 'contract' | 'part_time' | 'freelance' | 'internship' | 'unspecified';

export interface SourceFilterCfg {
  enabled?: boolean;
  regions?: Partial<Record<RegionFilterKey, boolean>>;
  job_types?: Partial<Record<JobTypeFilterKey, boolean>>;
  include_terms?: string[];
  exclude_terms?: string[];
  min_salary_usd?: number;
  max_age_days?: number;
}

export type SourceFiltersCfg = Partial<Record<SourceId, SourceFilterCfg>>;

export interface AppConfig {
  timezone: string;
  profile: { roles: string[]; grade: string; skills: string[]; constraints: string[] };
  search: { queries: string[]; areas: string[]; period_days: number; only_with_salary?: boolean };
  filters: {
    salary_min: number;
    currency: string;
    formats: string[];
    exclude_experience: string[];
    stop_words: string[];
    stop_companies: string[];
    agency_markers: string[];
    max_vacancy_age_days: number;
  };
  scoring: { threshold: number; resume_versions: Record<string, ResumeVersionCfg> };
  sending: { daily_cap: number; mode: string; veto_timeout_minutes: number; followup_days: number };
  letters: {
    tone: string;
    language: string;
    max_chars: number;
    use_style_examples?: boolean;
    style_examples_count?: number;
    max_revision_rounds?: number;
  };
  llm: {
    provider: string;
    scorer_model: string;
    scorer_price_in_per_mtok: number;
    scorer_price_out_per_mtok: number;
    letter_model: string;
    letter_price_in_per_mtok: number;
    letter_price_out_per_mtok: number;
    min_interval_ms: number;
    max_scores_per_run: number;
    max_letters_per_run: number;
    daily_cost_alert_usd: number;
  };
  telegram: { chat_id: string };
  hh?: { mode?: string };
  digest?: { list_size?: number; per_page?: number; detail_limit?: number };
  source_filters?: SourceFiltersCfg;
  prompts?: { dir?: string };
  letter_validation?: { banned_phrases?: string[]; template_junk?: string[] };
}

export interface RuntimeConfig extends AppConfig {
  paused: boolean;
}

export function scorerTaskCfg(cfg: AppConfig): LLMTaskCfg {
  return {
    model: cfg.llm.scorer_model,
    price_in_per_mtok: cfg.llm.scorer_price_in_per_mtok,
    price_out_per_mtok: cfg.llm.scorer_price_out_per_mtok,
  };
}

export function letterTaskCfg(cfg: AppConfig): LLMTaskCfg {
  return {
    model: cfg.llm.letter_model,
    price_in_per_mtok: cfg.llm.letter_price_in_per_mtok,
    price_out_per_mtok: cfg.llm.letter_price_out_per_mtok,
  };
}

export function loadFileConfig(root = process.cwd()): AppConfig {
  const p = path.join(root, 'config', 'settings.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
}

export async function loadRuntimeConfig(db: SupabaseClient, root = process.cwd()): Promise<RuntimeConfig> {
  const cfg = loadFileConfig(root) as RuntimeConfig;
  cfg.paused = false;

  const { data } = await db.from('settings').select('config').eq('user_id', OWNER_ID).maybeSingle();
  const overrides = (data?.config ?? {}) as Record<string, unknown>;
  if (typeof overrides.paused === 'boolean') cfg.paused = overrides.paused;
  if (typeof overrides.score_threshold === 'number') cfg.scoring.threshold = overrides.score_threshold;
  if (typeof overrides.daily_cap === 'number') cfg.sending.daily_cap = overrides.daily_cap;
  if (overrides.source_filters && typeof overrides.source_filters === 'object') {
    cfg.source_filters = overrides.source_filters as SourceFiltersCfg;
  }
  if (process.env.TELEGRAM_CHAT_ID?.trim()) cfg.telegram.chat_id = process.env.TELEGRAM_CHAT_ID.trim();

  return cfg;
}
