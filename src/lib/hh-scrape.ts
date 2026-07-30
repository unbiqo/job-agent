import type { SalaryJson } from './types';
import { sleep, stripHtml, truncate } from './util';

/**
 * Скрапинг публичных HTML-страниц hh.ru (поиск + страница вакансии).
 * Добавлен по новому требованию: у владельца нет доступа к api.hh.ru (403),
 * но server-rendered HTML отдаётся нормально. Ранее спека запрещала парсинг
 * HTML hh (см. vacancy-add.ts) — для scrape-пути это требование пересмотрено.
 *
 * Парсинг — по стабильным data-qa маркерам и встроенному JSON-состоянию
 * страницы (&#34;-экранированному). CSS-классы вида magritte-* обфусцированы
 * и НЕ используются.
 */

export const HH_SCRAPE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const HH_HOST = 'https://hh.ru';
const DESC_MAX_CHARS = 12_000;

export function unescapeHtml(s: string): string {
  return s
    .replace(/<!-- -->/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Текстовое содержимое HTML-фрагмента (теги и entity сняты, пробелы схлопнуты). */
function textOf(htmlFragment: string): string {
  return unescapeHtml(stripHtml(htmlFragment)).replace(/\s+/g, ' ').trim();
}

/**
 * Внутреннее содержимое первого элемента с data-qa="marker" — с подсчётом
 * вложенности одноимённых тегов (регуляркой по открывающим/закрывающим тегам,
 * без DOM-парсера).
 */
export function extractByDataQa(html: string, marker: string, fromIndex = 0): string | null {
  const i = html.indexOf(`data-qa="${marker}"`, fromIndex);
  if (i === -1) return null;
  const openStart = html.lastIndexOf('<', i);
  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(openStart));
  if (!tagMatch) return null;
  const tag = tagMatch[1].toLowerCase();
  const openEnd = html.indexOf('>', i);
  if (openEnd === -1) return null;
  let depth = 1;
  const re = new RegExp(`<(/?)${tag}(\\s[^>]*)?/?>`, 'gi');
  re.lastIndex = openEnd + 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].endsWith('/>')) continue;
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(openEnd + 1, m.index);
    } else {
      depth++;
    }
  }
  return null;
}

/** Все блоки с данным data-qa маркером (для списка карточек серпа). */
function extractAllByDataQa(html: string, marker: string): string[] {
  const out: string[] = [];
  const needle = `data-qa="${marker}"`;
  let pos = 0;
  for (;;) {
    const i = html.indexOf(needle, pos);
    if (i === -1) break;
    const inner = extractByDataQa(html, marker, pos);
    if (inner != null) out.push(inner);
    pos = i + needle.length;
  }
  return out;
}

/** href первого тега, несущего данный data-qa маркер. */
function hrefByDataQa(html: string, marker: string): string | null {
  const i = html.indexOf(`data-qa="${marker}"`);
  if (i === -1) return null;
  const openStart = html.lastIndexOf('<', i);
  const openEnd = html.indexOf('>', i);
  if (openStart === -1 || openEnd === -1) return null;
  const tag = html.slice(openStart, openEnd);
  const m = /href="([^"]+)"/.exec(tag);
  return m ? unescapeHtml(m[1]) : null;
}

const RU_MONTHS: Record<string, number> = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

/**
 * Дата публикации из человеческого текста hh: «сегодня», «вчера», «4 августа»
 * (опционально с годом). Без года берём текущий; если месяц «в будущем» —
 * значит, прошлый год. Возвращает ISO-строку (00:00 UTC) или null.
 */
export function parseRuDateText(text: string, now = new Date()): string | null {
  const t = text.toLowerCase().trim();
  const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (/^сегодня/.test(t)) return new Date(dayStart(now)).toISOString();
  if (/^вчера/.test(t)) return new Date(dayStart(now) - 86_400_000).toISOString();
  const m = t.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const month = RU_MONTHS[m[2]];
  if (month === undefined) return null;
  const day = Number(m[1]);
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  if (!m[3] && month > now.getUTCMonth()) year -= 1;
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/** Карта vacancyId → сведения из встроенного JSON-состояния страницы поиска. */
interface EmbeddedSearchInfo {
  publishedAt: string | null;
  salary: SalaryJson | null;
  scheduleId: string | null;
}

function parseEmbeddedSearchInfo(html: string): Map<string, EmbeddedSearchInfo> {
  const map = new Map<string, EmbeddedSearchInfo>();
  const needle = '&#34;vacancyId&#34;:';
  let pos = 0;
  for (;;) {
    const i = html.indexOf(needle, pos);
    if (i === -1) break;
    pos = i + needle.length;
    const idMatch = /^(\d+)/.exec(html.slice(pos));
    if (!idMatch) continue;
    const next = html.indexOf(needle, pos);
    // @workSchedule лежит в начале объекта вакансии — чуть раньше vacancyId
    const seg = html.slice(Math.max(0, i - 300), next === -1 ? pos + 20_000 : next);
    const pub = /&#34;publicationTime&#34;:\{[^}]*?&#34;\$&#34;:&#34;([^&]+?)&#34;/.exec(seg);
    const comp = /&#34;compensation&#34;:\{(?:&#34;noCompensation&#34;:\{)?([^}]*)\}/.exec(seg);
    let salary: SalaryJson | null = null;
    if (comp && !comp[0].includes('noCompensation')) {
      const num = (k: string) => {
        const x = new RegExp(`&#34;${k}&#34;:(\\d+)`).exec(comp[1]);
        return x ? Number(x[1]) : null;
      };
      const cur = /&#34;currencyCode&#34;:&#34;([A-Z]+)&#34;/.exec(comp[1]);
      const gross = /&#34;gross&#34;:(true|false)/.exec(comp[1]);
      salary = { from: num('from'), to: num('to'), currency: cur?.[1] ?? null, gross: gross ? gross[1] === 'true' : null };
    }
    const sched = /&#34;@workSchedule&#34;:&#34;([a-z]+)&#34;/.exec(seg);
    map.set(idMatch[1], {
      publishedAt: pub?.[1] ?? null,
      salary,
      scheduleId: sched?.[1] ?? null,
    });
  }
  return map;
}

export interface ScrapedSearchItem {
  id: string;
  title: string;
  url: string;
  employer: string | null;
  area: string | null;
  salaryText: string | null;
  salary: SalaryJson | null;
  publishedAt: string | null;
  scheduleId: string | null;
}

/** Разбор HTML страницы поиска hh (data-qa маркеры + встроенный JSON). */
export function parseSearchHtml(html: string, now = new Date()): ScrapedSearchItem[] {
  const embedded = parseEmbeddedSearchInfo(html);
  const blocks = extractAllByDataQa(html, 'vacancy-serp__vacancy');
  const items: ScrapedSearchItem[] = [];
  for (const block of blocks) {
    try {
      const id = /<div id="(\d+)"/.exec(block)?.[1];
      const titleRaw = extractByDataQa(block, 'serp-item__title-text');
      const title = titleRaw ? textOf(titleRaw) : '';
      if (!id || !title) continue; // битая карточка — пропускаем, не падаем
      const href = hrefByDataQa(block, 'serp-item__title');
      const employerRaw = extractByDataQa(block, 'vacancy-serp__vacancy-employer-text');
      const areaRaw = extractByDataQa(block, 'vacancy-serp__vacancy-address');
      // зарплатный текст без собственного data-qa — берём окрестность знака валюты
      let salaryText: string | null = null;
      const cur = /[₽$€₸]/.exec(block);
      if (cur) {
        const around = block.slice(Math.max(0, cur.index - 160), cur.index + 80);
        // окно может резать теги посередине — добиваем обрывы после stripHtml
        const cleaned = textOf(around)
          .replace(/<[^>]*$/g, '')
          .replace(/^[^<]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const m = /((?:от|до)\s+)?([\d\s]+(?:[–—-]\s*[\d\s]+)?)\s*(₽|\$|€|₸|Br)[^<]{0,40}/.exec(cleaned);
        if (m) salaryText = m[0].trim();
      }
      const info = embedded.get(id);
      let publishedAt = info?.publishedAt ?? null;
      if (!publishedAt) {
        // запасной путь для раскладок с видимой датой («сегодня», «4 августа»)
        const dateRaw = extractByDataQa(block, 'vacancy-serp__vacancy-date');
        if (dateRaw) publishedAt = parseRuDateText(textOf(dateRaw), now);
      }
      items.push({
        id,
        title,
        url: href ?? `${HH_HOST}/vacancy/${id}`,
        employer: employerRaw ? textOf(employerRaw) : null,
        area: areaRaw ? textOf(areaRaw) : null,
        salaryText,
        salary: info?.salary ?? null,
        publishedAt,
        scheduleId: info?.scheduleId ?? null,
      });
    } catch {
      // одна битая карточка не должна ронять весь прогон
    }
  }
  if (items.length === 0) {
    throw new Error('hh поиск: не распарсилось ни одной карточки вакансии — похоже, разметка страницы изменилась');
  }
  return items;
}

export interface ScrapedVacancy {
  id: string;
  title: string;
  employer: string | null;
  salary: SalaryJson | null;
  salaryText: string | null;
  description: string | null;
  experience: string | null;
  address: string | null;
  publishedAt: string | null;
  hasTest: boolean | null;
  responseLetterRequired: boolean | null;
  remote: boolean;
  keySkills: string[];
  url: string;
}

function boolJsonField(segment: string, names: string[]): boolean | null {
  for (const name of names) {
    const escaped = new RegExp(`&#34;${name}&#34;:(true|false)`).exec(segment);
    if (escaped) return escaped[1] === 'true';
    const plain = new RegExp(`"${name}":(true|false)`).exec(segment);
    if (plain) return plain[1] === 'true';
  }
  return null;
}

/** Разбор HTML страницы вакансии hh. */
export function parseVacancyHtml(id: string, html: string): ScrapedVacancy {
  const titleRaw = extractByDataQa(html, 'vacancy-title');
  const title = titleRaw ? textOf(titleRaw) : '';
  if (!title) {
    throw new Error(`hh вакансия ${id}: не найден заголовок (data-qa="vacancy-title") — разметка изменилась?`);
  }
  const grab = (marker: string) => {
    const raw = extractByDataQa(html, marker);
    return raw ? textOf(raw) : null;
  };
  const descRaw = extractByDataQa(html, 'vacancy-description');
  const description = descRaw ? truncate(stripHtml(unescapeHtml(descRaw)), DESC_MAX_CHARS) : null;

  // структурированные поля из встроенного JSON-состояния страницы
  // (hasTests лежит чуть раньше vacancyId — берём окно с запасом назад)
  const vi = html.indexOf(`&#34;vacancyId&#34;:${id}`);
  const seg = vi === -1 ? html : html.slice(Math.max(0, vi - 2000), vi + 30_000);
  let salary: SalaryJson | null = null;
  const comp = /&#34;compensation&#34;:\{([^}]*)\}/.exec(seg);
  if (comp && !comp[0].includes('noCompensation')) {
    const num = (k: string) => {
      const x = new RegExp(`&#34;${k}&#34;:(\\d+)`).exec(comp[1]);
      return x ? Number(x[1]) : null;
    };
    const cur = /&#34;currencyCode&#34;:&#34;([A-Z]+)&#34;/.exec(comp[1]);
    const gross = /&#34;gross&#34;:(true|false)/.exec(comp[1]);
    salary = { from: num('from'), to: num('to'), currency: cur?.[1] ?? null, gross: gross ? gross[1] === 'true' : null };
  }
  const pub = /&#34;publicationDate&#34;:&#34;([^&]+?)&#34;/.exec(seg);
  const sched = /&#34;@workSchedule&#34;:&#34;([a-z]+)&#34;/.exec(seg);
  const test = boolJsonField(seg, ['hasTests', 'has_test']);
  const responseLetterRequired = boolJsonField(seg, [
    'responseLetterRequired',
    'response_letter_required',
    'letterRequired',
    'letter_required',
  ]);
  const workFormats = grab('work-formats-text') ?? '';
  const remote = sched?.[1] === 'remote' || /удал[её]н|remote/i.test(workFormats);

  // ключевых навыков на странице может не быть (keySkills:null) — тогда []
  const keySkills: string[] = [];
  const ks = /&#34;keySkills&#34;:\{(.{0,3000}?)\}/.exec(seg);
  if (ks) {
    for (const m of ks[1].matchAll(/&#34;name&#34;:&#34;([^&]+?)&#34;/g)) keySkills.push(m[1]);
  }

  return {
    id,
    title,
    employer: grab('vacancy-company-name'),
    salary,
    salaryText: grab('vacancy-salary'),
    description,
    experience: grab('vacancy-experience'),
    address: grab('vacancy-address-with-map'),
    publishedAt: pub?.[1] ?? null,
    hasTest: test,
    responseLetterRequired,
    remote,
    keySkills,
    url: `${HH_HOST}/vacancy/${id}`,
  };
}

export interface ScrapeOptions {
  /** Подмена fetch для тестов. */
  fetchImpl?: typeof fetch;
  /** Минимальный интервал между запросами (троттлинг ~1 запрос/с). */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class HHScrapeError extends Error {}

export class HHScraper {
  private lastRequestAt = 0;
  private fetchImpl: typeof fetch;
  private minIntervalMs: number;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(opts: ScrapeOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async fetchHtml(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            'User-Agent': HH_SCRAPE_UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (attempt >= this.maxRetries) throw new HHScrapeError(`hh scrape: сеть недоступна для ${url}: ${e}`);
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) throw new HHScrapeError(`hh scrape ${res.status} для ${url} — ретраи исчерпаны`);
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new HHScrapeError(`hh scrape ${res.status} для ${url}`);
      return await res.text();
    }
  }

  /** Свежие вакансии по запросу (сортировка hh по publication_time). */
  async scrapeSearch(query: string, opts: { areas?: string[]; perPage?: number } = {}): Promise<ScrapedSearchItem[]> {
    const url = new URL(HH_HOST + '/search/vacancy');
    url.searchParams.set('text', query);
    url.searchParams.set('order_by', 'publication_time');
    url.searchParams.set('per_page', String(opts.perPage ?? 50));
    for (const a of opts.areas ?? []) url.searchParams.append('area', a);
    return parseSearchHtml(await this.fetchHtml(url.toString()));
  }

  /** Детали одной вакансии по id. */
  async scrapeVacancy(id: string): Promise<ScrapedVacancy> {
    return parseVacancyHtml(id, await this.fetchHtml(`${HH_HOST}/vacancy/${id}`));
  }
}
