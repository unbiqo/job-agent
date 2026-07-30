import { sleep } from './util';

const BASE = 'https://api.hh.ru';

export function hhUserAgent(): string {
  return process.env.HH_USER_AGENT || 'JobAgent/1.0 (job-agent)';
}

export interface HHSearchItem {
  id: string;
  name: string;
  employer?: { id?: string; name?: string };
  salary?: { from?: number | null; to?: number | null; currency?: string | null; gross?: boolean | null } | null;
  area?: { id?: string; name?: string };
  published_at: string;
  archived?: boolean;
  has_test?: boolean;
  schedule?: { id?: string; name?: string };
  experience?: { id?: string; name?: string };
  [k: string]: unknown;
}

export interface HHVacancyDetail extends HHSearchItem {
  description?: string;
  key_skills?: { name: string }[];
  response_letter_required?: boolean;
}

export class HHError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`hh API ${status}: ${body.slice(0, 300)}`);
  }
}

type QueryValue = string | number | boolean | string[] | undefined;

export class HHClient {
  private lastRequestAt = 0;

  constructor(private opts: { userAgent: string }) {}

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request<T>(
    path: string,
    init: { method?: string; query?: Record<string, QueryValue>; form?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.append(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const headers: Record<string, string> = {
        'HH-User-Agent': this.opts.userAgent,
        'User-Agent': this.opts.userAgent,
      };
      let body: string | undefined;
      if (init.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(init.form).toString();
      }

      const res = await fetch(url, { method: init.method ?? 'GET', headers, body });
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        if (attempt >= 5) throw new HHError(res.status, text);
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HHError(res.status, text);
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  searchVacancies(query: Record<string, QueryValue>) {
    return this.request<{ items: HHSearchItem[]; pages: number; page: number; found: number }>('/vacancies', {
      query,
    });
  }

  getVacancy(id: string) {
    return this.request<HHVacancyDetail>(`/vacancies/${id}`);
  }
}
