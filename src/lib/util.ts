export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|ul|ol|div|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectLanguage(text: string): 'ru' | 'en' {
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr >= lat ? 'ru' : 'en';
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function tzOffsetMinutes(tz: string, date: Date): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const [, mo, da, yr, h, mi, se] = m;
  const asUtc = Date.UTC(Number(yr), Number(mo) - 1, Number(da), Number(h) % 24, Number(mi), Number(se));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Начало «сегодня» в заданном часовом поясе (для дневного лимита и стоимости). */
export function startOfDayInTz(tz: string, now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = fmt.format(now).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset = tzOffsetMinutes(tz, new Date(guess));
  return new Date(guess - offset * 60_000);
}

export function vacancyAgeDays(publishedAt: string | null | undefined, now = new Date()): number {
  if (!publishedAt) return 0;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0;
  return (now.getTime() - t) / 86_400_000;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
