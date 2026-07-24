import type { HHSearchItem } from './hh';

/**
 * v2-точка расширения (спека 3.3 / раздел 11): единый интерфейс источников вакансий.
 * В v0/v1 единственный источник — hh.ru API. Habr Career, Getmatch, Telegram-каналы,
 * email-подписки Gmail подключаются реализацией этого интерфейса.
 *
 * TODO(v2): Gmail email-подписки — НЕ реализовывать сейчас (спека 3.3, Задача 3).
 *   Реализация должна возвращать VacancyCandidate[] с source-меткой и, при
 *   неполных данных, помечать их fallback-флагом (см. vacancy-add.ts).
 */
export interface VacancyCandidate {
  id: string;
  title: string;
  employer?: string | null;
  url?: string;
  description?: string;
  raw?: Partial<HHSearchItem> & { source?: string };
}

export interface VacancySource {
  /** Стабильный идентификатор источника, попадает в raw.source. */
  readonly name: string;
  /** Свежие кандидаты с момента since (или за окно по умолчанию). */
  fetch(opts: { queries: string[]; since?: Date }): Promise<VacancyCandidate[]>;
}
