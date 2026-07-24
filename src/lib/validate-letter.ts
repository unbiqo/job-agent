import type { AppConfig } from './config';

/**
 * Задача 4 слоя качества: детерминированный валидатор писем (без LLM).
 * Запускается после каждой генерации. Правила:
 *  - length         — длина ≤ лимита из конфига;
 *  - banned_phrase  — стоп-фразы из settings (letter_validation.banned_phrases);
 *  - fact_check     — все ссылки/числа присутствуют в profile KB (подстрока);
 *  - template_junk  — шаблонный LLM-мусор («как искусственный интеллект» и т.п.).
 * При провале — одна автоматическая регенерация с указанием нарушения,
 * при повторном провале письмо уходит в needs_review (см. letters.ts).
 */
export type LetterRule = 'length' | 'banned_phrase' | 'fact_check' | 'template_junk';

export interface LetterViolation {
  rule: LetterRule;
  detail: string;
}

export interface ValidateLetterOptions {
  maxChars: number;
  bannedPhrases: string[];
  templateJunk: string[];
  /** Корпус базы знаний профиля — против него проверяются факты. */
  corpus: string;
  /** Текст вакансии — числа из него (зарплата и т.п.) не считаются выдумкой. */
  vacancyText?: string;
}

const DEFAULT_TEMPLATE_JUNK = [
  'как искусственный интеллект',
  'как языковая модель',
  'я большой языковой модел',
  'я языковая модель',
  'as an ai',
  'as a language model',
  'large language model',
  '[вставьте',
  '[ваше имя]',
  '[insert',
];

const DEFAULT_BANNED = ['вайбкодинг'];

/** Дефолты + расширения из settings.json → letter_validation. */
export function letterValidationCfg(cfg: AppConfig): { bannedPhrases: string[]; templateJunk: string[] } {
  return {
    bannedPhrases: [...DEFAULT_BANNED, ...(cfg.letter_validation?.banned_phrases ?? [])],
    templateJunk: [...DEFAULT_TEMPLATE_JUNK, ...(cfg.letter_validation?.template_junk ?? [])],
  };
}

/**
 * Guardrail 5 ТЗ («ноль выдумок»): ссылки и числа в письме обязаны присутствовать
 * в базе знаний профиля (числа — допускаются также из текста вакансии).
 * Возвращает список нарушений; пустой список = факты чисты.
 */
export function validateLetterFacts(letter: string, corpus: string, vacancyText = ''): string[] {
  const violations: string[] = [];
  const hay = (corpus + '\n' + vacancyText).toLowerCase();
  const hayCompact = hay.replace(/[\s ]/g, '');

  const urls = letter.match(/https?:\/\/[^\s)\]>"',;]+/g) ?? [];
  for (const rawUrl of urls) {
    const url = rawUrl.replace(/[.,]+$/, '').replace(/\/+$/, '').toLowerCase();
    if (!hay.includes(url) && !hayCompact.includes(url.replace(/[\s ]/g, ''))) {
      violations.push(`ссылка отсутствует в базе знаний: ${rawUrl}`);
    }
  }

  const numbers = letter.match(/\d+(?:[.,]\d+)?\s*%|\d{2,}/g) ?? [];
  for (const num of numbers) {
    const digits = num.replace(/\D/g, '');
    if (!digits) continue;
    if (!hay.includes(digits) && !hayCompact.includes(digits)) {
      violations.push(`число/метрика отсутствует в базе знаний: «${num.trim()}»`);
    }
  }
  return violations;
}

/** Полная детерминированная проверка письма. Пустой массив = письмо валидно. */
export function validateLetter(letter: string, opts: ValidateLetterOptions): LetterViolation[] {
  const violations: LetterViolation[] = [];
  const lower = letter.toLowerCase();

  if (letter.length > opts.maxChars) {
    violations.push({ rule: 'length', detail: `длина ${letter.length} > лимита ${opts.maxChars}` });
  }

  for (const phrase of opts.bannedPhrases) {
    if (phrase && lower.includes(phrase.toLowerCase())) {
      violations.push({ rule: 'banned_phrase', detail: `стоп-фраза: «${phrase}»` });
    }
  }

  for (const junk of opts.templateJunk) {
    if (junk && lower.includes(junk.toLowerCase())) {
      violations.push({ rule: 'template_junk', detail: `шаблонный мусор: «${junk}»` });
    }
  }

  for (const detail of validateLetterFacts(letter, opts.corpus, opts.vacancyText ?? '')) {
    violations.push({ rule: 'fact_check', detail });
  }

  return violations;
}

export function formatViolations(violations: LetterViolation[]): string {
  return violations.map((v) => `[${v.rule}] ${v.detail}`).join('; ');
}
