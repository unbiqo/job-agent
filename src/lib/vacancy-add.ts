import { stripHtml } from './util';

// v1.1 FALLBACK-минимум (спека 3.3, Задача 3): ручное добавление вакансии командой
// /add. Парсинг HTML страниц hh запрещён спекой — используем только API по id.
export const FALLBACK_FLAG = 'данные неполные: fallback-источник';

/** Вакансия из ручного источника (не из штатного поиска hh). */
export function isFallback(v: { raw: Record<string, unknown> | null }): boolean {
  return (v.raw as { source?: string } | null)?.source === 'fallback';
}

/** Гарантирует наличие fallback-флага среди red_flags (для писем и скоринга). */
export function withFallbackFlag(flags: string[]): string[] {
  return flags.includes(FALLBACK_FLAG) ? flags : [...flags, FALLBACK_FLAG];
}

export interface ParsedVacancyInput {
  /** id вакансии hh, если во входе была ссылка/числовой id; иначе null (свободный текст). */
  hhId: string | null;
  /** Очищенный текст (для свободного описания вакансии). */
  text: string;
}

/**
 * Разбор аргумента /add: ссылка hh (ru/kz/uz/by/az/kg) или голый числовой id → hhId;
 * иначе трактуем как свободный текст вакансии. HTML не парсим (спека).
 */
export function parseVacancyInput(input: string): ParsedVacancyInput {
  const text = input.trim();
  const byUrl = text.match(/hh\.(?:ru|kz|uz|by|az|kg)\/vacancy\/(\d+)/i) ?? text.match(/\/vacancy\/(\d+)/);
  if (byUrl) return { hhId: byUrl[1], text };
  const byId = text.match(/^(\d{5,})$/);
  if (byId) return { hhId: byId[1], text };
  return { hhId: null, text: stripHtml(text) };
}

/** Синтетический id для вакансии, добавленной свободным текстом (без id hh). */
export function manualVacancyId(now = Date.now()): string {
  return `manual:${now}`;
}
