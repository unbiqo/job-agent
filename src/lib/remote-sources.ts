import type { SalaryJson } from './types';
import { stripHtml, truncate } from './util';

export type RemoteSourceId = 'remoteok' | 'wwr';

export interface RemoteJobCandidate {
  id: string;
  source: RemoteSourceId;
  title: string;
  url: string;
  employer: string | null;
  area: string | null;
  publishedAt: string | null;
  description: string | null;
  salary: SalaryJson | null;
  keySkills: string[];
  raw: Record<string, unknown>;
}

const DESC_MAX_CHARS = 12_000;

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tagValue(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return m ? decodeXml(m[1]).trim() : null;
}

function cleanDescription(html: string | null): string | null {
  if (!html) return null;
  return truncate(stripHtml(decodeXml(html)), DESC_MAX_CHARS);
}

function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw * 1000).toISOString();
  const text = String(raw).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

interface RemoteOkApiRow {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  date?: string;
  epoch?: number;
  apply_url?: string;
  url?: string;
}

export function parseRemoteOkApi(rows: unknown): RemoteJobCandidate[] {
  if (!Array.isArray(rows)) return [];
  const out: RemoteJobCandidate[] = [];
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object' || !('position' in candidate)) continue;
    const row = candidate as RemoteOkApiRow;
    const id = String(row.id ?? row.slug ?? '').trim();
    const title = String(row.position ?? '').trim();
    const url = String(row.apply_url ?? row.url ?? '').trim();
    if (!id || !title || !url) continue;
    const salary: SalaryJson | null =
      row.salary_min || row.salary_max
        ? { from: row.salary_min || null, to: row.salary_max || null, currency: 'USD', gross: null }
        : null;
    const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    out.push({
      id: `remoteok:${id}`,
      source: 'remoteok',
      title,
      url,
      employer: row.company ?? null,
      area: row.location ?? null,
      publishedAt: parseDate(row.date ?? row.epoch),
      description: cleanDescription(row.description ?? null),
      salary,
      keySkills: tags,
      raw: {
        source: 'remoteok',
        url,
        tags,
        remote: true,
        schedule: { id: 'remote' },
      },
    });
  }
  return out;
}

export function parseWwrRss(xml: string): RemoteJobCandidate[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const out: RemoteJobCandidate[] = [];
  for (const item of items) {
    const titleRaw = tagValue(item, 'title') ?? '';
    const link = tagValue(item, 'link') ?? '';
    const guid = tagValue(item, 'guid') ?? link;
    if (!titleRaw || !link || !guid) continue;
    const [companyPart, ...titleParts] = titleRaw.split(':');
    const title = (titleParts.length ? titleParts.join(':') : titleRaw).trim();
    const employer = titleParts.length ? companyPart.trim() : null;
    const category = tagValue(item, 'category');
    const type = tagValue(item, 'type');
    const skills = (tagValue(item, 'skills') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = [category, type, ...skills].filter((x): x is string => Boolean(x));
    const area = [tagValue(item, 'region'), tagValue(item, 'country'), tagValue(item, 'state')].filter(Boolean).join(', ') || null;
    const slug = guid.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    out.push({
      id: `wwr:${slug}`,
      source: 'wwr',
      title,
      url: link,
      employer,
      area,
      publishedAt: parseDate(tagValue(item, 'pubDate')),
      description: cleanDescription(tagValue(item, 'description')),
      salary: null,
      keySkills: tags,
      raw: {
        source: 'wwr',
        url: link,
        category,
        type,
        skills,
        remote: true,
        schedule: { id: 'remote' },
      },
    });
  }
  return out;
}

export async function fetchRemoteOkJobs(fetchImpl: typeof fetch = fetch): Promise<RemoteJobCandidate[]> {
  const res = await fetchImpl('https://remoteok.com/api', {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'job-agent/1.0 (+https://job-agent-ecru.vercel.app)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Remote OK API ${res.status}`);
  return parseRemoteOkApi(await res.json());
}

export async function fetchWwrJobs(fetchImpl: typeof fetch = fetch): Promise<RemoteJobCandidate[]> {
  const res = await fetchImpl('https://weworkremotely.com/remote-jobs.rss', {
    headers: {
      Accept: 'application/rss+xml,text/xml',
      'User-Agent': 'job-agent/1.0 (+https://job-agent-ecru.vercel.app)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`We Work Remotely RSS ${res.status}`);
  return parseWwrRss(await res.text());
}
