import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OWNER_ID } from './db';

export interface ResumeVersionCfg {
  title: string;
  hh_resume_id: string;
  file: string;
}

export type SendMode = 'review' | 'veto' | 'autopilot';
export type HHMode = 'auto' | 'full' | 'no_oauth' | 'fallback';

export interface LLMTaskCfg {
  model: string;
  price_in_per_mtok: number;
  price_out_per_mtok: number;
}

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
  sending: { daily_cap: number; mode: SendMode; veto_timeout_minutes: number; followup_days: number };
  letters: {
    tone: string;
    language: string;
    max_chars: number;
    // задача 9: few-shot эталонов стиля в промпт ПИСЬМА (дефолт off; работает при ≥3 эталонах)
    use_style_examples?: boolean;
    style_examples_count?: number;
    // задача 8: лимит LLM-раундов правки одного письма, дальше needs_manual
    max_revision_rounds?: number;
  };
  llm: {
    provider: string;
    // разные модели под разные задачи: скоринг — высокий объём/простая оценка
    // (дешёвая модель), письма — важно качество (модель уровнем выше).
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
  // v1.1: лесенка деградации hh (спека 3.3). Опционально; отсутствие = auto.
  hh?: { mode?: HHMode };
  // v1.2: дельта-поллинг (спека 3.4а). Опционально; отсутствие = выключено.
  delta_poll?: { enabled?: boolean; interval_min?: number; hot_threshold?: number };
  // Слой качества (evals + аналитика). Все секции опциональны — дефолты в хелперах ниже.
  prompts?: { dir?: string };
  evals?: {
    golden_path?: string;
    reports_dir?: string;
    golden_min_age_days?: number;
    min_set_size?: number;
  };
  letter_validation?: { banned_phrases?: string[]; template_junk?: string[] };
  analytics?: { stopwords_extra?: string[]; tech_terms?: string[]; top_n?: number };
}

export interface RuntimeConfig extends AppConfig {
  paused: boolean;
}

export interface EvalsCfg {
  golden_path: string;
  reports_dir: string;
  golden_min_age_days: number;
  min_set_size: number;
}

/** Настройки evals с дефолтами (холодный старт: секции может не быть в settings.json). */
export function evalsCfg(cfg: AppConfig): EvalsCfg {
  return {
    golden_path: cfg.evals?.golden_path ?? 'evals/golden.json',
    reports_dir: cfg.evals?.reports_dir ?? 'evals/reports',
    golden_min_age_days: cfg.evals?.golden_min_age_days ?? 3,
    min_set_size: cfg.evals?.min_set_size ?? 5,
  };
}

/** Цена/модель скоринга в форме LLMTaskCfg — для addUsage (см. cost.ts). */
export function scorerTaskCfg(cfg: AppConfig): LLMTaskCfg {
  return {
    model: cfg.llm.scorer_model,
    price_in_per_mtok: cfg.llm.scorer_price_in_per_mtok,
    price_out_per_mtok: cfg.llm.scorer_price_out_per_mtok,
  };
}

/** Цена/модель писем в форме LLMTaskCfg — для addUsage (см. cost.ts). */
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

/**
 * Конфиг v0 = файл config/settings.json + мутабельные overrides из БД
 * (settings.config: { send_mode, paused, score_threshold, daily_cap } — их меняет
 * Telegram-бот командами /mode, /pause, /resume) + env-переопределения.
 */
export async function loadRuntimeConfig(db: SupabaseClient, root = process.cwd()): Promise<RuntimeConfig> {
  const cfg = loadFileConfig(root) as RuntimeConfig;
  cfg.paused = false;
  const { data } = await db.from('settings').select('config').eq('user_id', OWNER_ID).maybeSingle();
  const o = (data?.config ?? {}) as Record<string, unknown>;
  if (o.send_mode === 'review' || o.send_mode === 'veto' || o.send_mode === 'autopilot') {
    cfg.sending.mode = o.send_mode;
  }
  if (typeof o.paused === 'boolean') cfg.paused = o.paused;
  if (typeof o.score_threshold === 'number') cfg.scoring.threshold = o.score_threshold;
  if (typeof o.daily_cap === 'number') cfg.sending.daily_cap = o.daily_cap;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram.chat_id = process.env.TELEGRAM_CHAT_ID;
  return cfg;
}

export async function setConfigOverride(db: SupabaseClient, patch: Record<string, unknown>): Promise<void> {
  const { data } = await db.from('settings').select('config').eq('user_id', OWNER_ID).maybeSingle();
  const next = { ...((data?.config as Record<string, unknown>) ?? {}), ...patch };
  const { error } = await db.from('settings').upsert({ user_id: OWNER_ID, config: next });
  if (error) throw new Error('settings upsert: ' + error.message);
}
