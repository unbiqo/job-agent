import type { VacancyRow } from './types';

export function responseLetterRequired(v: Pick<VacancyRow, 'raw'>): boolean | null {
  const raw = (v.raw ?? {}) as Record<string, unknown>;
  for (const key of ['response_letter_required', 'responseLetterRequired', 'letter_required', 'letterRequired']) {
    const value = raw[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}
