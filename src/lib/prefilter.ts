import type { AppConfig } from './config';
import type { SalaryJson, VacancyRow } from './types';
import { vacancyAgeDays } from './util';

export interface PrefilterVerdict {
  passed: boolean;
  reason?: string;
}

type PrefilterVacancy = Pick<
  VacancyRow,
  'title' | 'employer' | 'description' | 'salary' | 'published_at' | 'has_test' | 'raw'
>;

function no(reason: string): PrefilterVerdict {
  return { passed: false, reason };
}

function looksRemote(v: PrefilterVacancy, text: string): boolean {
  const raw = (v.raw ?? {}) as {
    schedule?: { id?: string };
    work_format?: { id?: string }[];
  };
  if (raw.schedule?.id === 'remote') return true;
  if (Array.isArray(raw.work_format) && raw.work_format.some((f) => f?.id === 'REMOTE')) return true;
  return /удал[её]н|remote/i.test(text);
}

/**
 * Детерминированный префильтр (шаг 4 пайплайна, раздел 3.4 ТЗ) — бесплатно, без LLM.
 * Возвращает первую сработавшую причину исключения.
 */
export function prefilter(v: PrefilterVacancy, cfg: AppConfig, now = new Date()): PrefilterVerdict {
  const raw = (v.raw ?? {}) as { archived?: boolean; experience?: { id?: string } };
  const title = (v.title ?? '').toLowerCase();
  const employer = (v.employer ?? '').toLowerCase();
  const description = (v.description ?? '').toLowerCase();
  const text = title + '\n' + description;

  if (raw.archived) return no('вакансия в архиве');

  if (vacancyAgeDays(v.published_at, now) > cfg.filters.max_vacancy_age_days) {
    return no(`старше ${cfg.filters.max_vacancy_age_days} дней`);
  }

  // Guardrail 2: с тестом не отправляем — помечаем «нужен ручной отклик»
  if (v.has_test) return no('has_test: нужен ручной отклик');

  for (const c of cfg.filters.stop_companies) {
    if (c && employer.includes(c.toLowerCase())) return no(`стоп-компания: ${c}`);
  }
  for (const m of cfg.filters.agency_markers) {
    if (m && employer.includes(m.toLowerCase())) return no(`агентство по признаку: ${m}`);
  }

  const exp = raw.experience?.id;
  if (exp && cfg.filters.exclude_experience.includes(exp)) return no(`требуемый опыт: ${exp}`);

  for (const w of cfg.filters.stop_words) {
    if (w && text.includes(w.toLowerCase())) return no(`стоп-слово: «${w}»`);
  }

  const remoteOnly = cfg.filters.formats.length > 0 && cfg.filters.formats.every((f) => f === 'remote');
  if (remoteOnly && !looksRemote(v, text)) return no('формат: не удалённая работа');

  const s: SalaryJson | null = v.salary ?? null;
  if (cfg.filters.salary_min > 0 && s && s.currency === cfg.filters.currency) {
    const upper = s.to ?? s.from;
    if (upper != null && upper < cfg.filters.salary_min) {
      return no(`зарплата ниже минимума (${upper} < ${cfg.filters.salary_min} ${cfg.filters.currency})`);
    }
  }

  return { passed: true };
}
