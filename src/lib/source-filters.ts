import type { RegionFilterKey, SourceFilterCfg, SourceFiltersCfg, SourceId, JobTypeFilterKey } from './config';
import type { SalaryJson } from './types';
import { vacancyAgeDays } from './util';

export interface SourceFilterInput {
  source: SourceId;
  title: string;
  employer?: string | null;
  area?: string | null;
  description?: string | null;
  key_skills?: string[] | null;
  salary?: SalaryJson | null;
  published_at?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface SourceFilterResult {
  passed: boolean;
  reason?: string;
  regions: RegionFilterKey[];
  jobTypes: JobTypeFilterKey[];
}

const REGION_KEYS: RegionFilterKey[] = ['worldwide', 'us', 'canada', 'uk', 'europe', 'latin_america', 'asia', 'unspecified'];
const JOB_TYPE_KEYS: JobTypeFilterKey[] = ['full_time', 'contract', 'part_time', 'freelance', 'internship', 'unspecified'];

function boolDefault(value: boolean | undefined, fallback: boolean): boolean {
  return value == null ? fallback : value;
}

function textOf(v: SourceFilterInput): string {
  return [v.title, v.employer ?? '', v.area ?? '', v.description ?? '', ...(v.key_skills ?? []), JSON.stringify(v.raw ?? {})].join(' ').toLowerCase();
}

export function detectRegions(v: SourceFilterInput): RegionFilterKey[] {
  const text = textOf(v);
  const out = new Set<RegionFilterKey>();

  if (/\b(worldwide|anywhere|global|international|all countries|work from anywhere)\b/.test(text)) out.add('worldwide');
  if (/\b(us only|usa only|u\.s\. only|united states only|united states|usa|u\.s\.|america|north america)\b/.test(text)) out.add('us');
  if (/\b(canada|canadian)\b/.test(text)) out.add('canada');
  if (/\b(uk only|united kingdom|great britain|england|london|uk)\b/.test(text)) out.add('uk');
  if (/\b(eu only|europe only|europe|european|emea|cet|cest)\b/.test(text)) out.add('europe');
  if (/\b(latam|latin america|south america|mexico|brazil|argentina|chile|colombia)\b/.test(text)) out.add('latin_america');
  if (/\b(asia|apac|australia|new zealand|singapore|india|japan|korea|philippines)\b/.test(text)) out.add('asia');

  if (!out.size) out.add('unspecified');
  return REGION_KEYS.filter((key) => out.has(key));
}

export function detectJobTypes(v: SourceFilterInput): JobTypeFilterKey[] {
  const text = textOf(v);
  const out = new Set<JobTypeFilterKey>();

  if (/\b(full[-\s]?time|fulltime|permanent)\b/.test(text)) out.add('full_time');
  if (/\b(contract|contractor|b2b|1099)\b/.test(text)) out.add('contract');
  if (/\b(part[-\s]?time|parttime)\b/.test(text)) out.add('part_time');
  if (/\b(freelance|freelancer)\b/.test(text)) out.add('freelance');
  if (/\b(intern|internship|trainee)\b/.test(text)) out.add('internship');

  if (!out.size) out.add('unspecified');
  return JOB_TYPE_KEYS.filter((key) => out.has(key));
}

function salaryUsd(v: SourceFilterInput): number | null {
  const s = v.salary;
  if (!s || (s.from == null && s.to == null)) return null;
  if ((s.currency ?? '').toUpperCase() !== 'USD') return null;
  return s.from ?? s.to ?? null;
}

function splitTerms(terms: string[] | undefined): string[] {
  return (terms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
}

function sourceCfg(filters: SourceFiltersCfg | undefined, source: SourceId): SourceFilterCfg {
  return filters?.[source] ?? {};
}

export function applySourceFilter(v: SourceFilterInput, filters?: SourceFiltersCfg, now = new Date()): SourceFilterResult {
  const cfg = sourceCfg(filters, v.source);
  const regions = detectRegions(v);
  const jobTypes = detectJobTypes(v);
  const text = textOf(v);

  if (boolDefault(cfg.enabled, true) === false) return { passed: false, reason: 'source disabled', regions, jobTypes };

  const maxAge = cfg.max_age_days;
  if (typeof maxAge === 'number' && maxAge > 0 && vacancyAgeDays(v.published_at, now) > maxAge) {
    return { passed: false, reason: `older than ${maxAge}d`, regions, jobTypes };
  }

  const minUsd = cfg.min_salary_usd ?? 0;
  const usd = salaryUsd(v);
  if (minUsd > 0 && usd != null && usd < minUsd) {
    return { passed: false, reason: `salary below $${minUsd}`, regions, jobTypes };
  }

  const includeTerms = splitTerms(cfg.include_terms);
  if (includeTerms.length && !includeTerms.some((term) => text.includes(term))) {
    return { passed: false, reason: 'missing include terms', regions, jobTypes };
  }

  const excludeTerms = splitTerms(cfg.exclude_terms);
  const excluded = excludeTerms.find((term) => text.includes(term));
  if (excluded) return { passed: false, reason: `excluded term: ${excluded}`, regions, jobTypes };

  const allowedRegions = cfg.regions ?? {};
  if (!regions.some((key) => boolDefault(allowedRegions[key], true))) {
    return { passed: false, reason: `region blocked: ${regions.join(',')}`, regions, jobTypes };
  }

  const allowedTypes = cfg.job_types ?? {};
  if (!jobTypes.some((key) => boolDefault(allowedTypes[key], key !== 'internship'))) {
    return { passed: false, reason: `job type blocked: ${jobTypes.join(',')}`, regions, jobTypes };
  }

  return { passed: true, regions, jobTypes };
}
