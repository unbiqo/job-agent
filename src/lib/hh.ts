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

export interface HHNegotiationItem {
  id: string;
  state?: { id?: string; name?: string };
  viewed_by_opponent?: boolean;
  created_at?: string;
  updated_at?: string;
  vacancy?: HHSearchItem | null;
  [k: string]: unknown;
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

  constructor(private opts: { userAgent: string; accessToken?: string }) {}

  /** ≤5 rps по ТЗ; держим ~4 rps. */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request<T>(
    path: string,
    init: { method?: string; query?: Record<string, QueryValue>; form?: Record<string, string>; auth?: boolean } = {},
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
      if (init.auth) {
        if (!this.opts.accessToken) throw new Error('Нет access token hh — выполните npm run hh-auth');
        headers['Authorization'] = 'Bearer ' + this.opts.accessToken;
      }
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

  getMyResumes() {
    return this.request<{ items: { id: string; title: string }[] }>('/resumes/mine', { auth: true });
  }

  getNegotiations(page = 0, perPage = 100) {
    return this.request<{ items: HHNegotiationItem[]; pages: number; page: number }>('/negotiations', {
      auth: true,
      query: { page, per_page: perPage },
    });
  }

  /** POST /negotiations → 201. Ошибки 400/403 (уже откликался, нужен тест, архив) летят как HHError. */
  async apply(vacancyId: string, resumeId: string, message: string): Promise<void> {
    await this.request<void>('/negotiations', {
      method: 'POST',
      auth: true,
      form: { vacancy_id: vacancyId, resume_id: resumeId, message },
    });
  }
}

export interface HHTokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(form: Record<string, string>): Promise<HHTokenSet> {
  const res = await fetch(BASE + '/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HH-User-Agent': hhUserAgent(),
      'User-Agent': hhUserAgent(),
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new HHError(res.status, text);
  return JSON.parse(text) as HHTokenSet;
}

export function hhExchangeCode(code: string): Promise<HHTokenSet> {
  const clientId = process.env.HH_CLIENT_ID;
  const clientSecret = process.env.HH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('HH_CLIENT_ID и HH_CLIENT_SECRET обязательны');
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
  };
  if (process.env.HH_REDIRECT_URI) form.redirect_uri = process.env.HH_REDIRECT_URI;
  return tokenRequest(form);
}

export function hhRefreshToken(refreshToken: string): Promise<HHTokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

export function hhAuthorizeUrl(): string {
  const clientId = process.env.HH_CLIENT_ID;
  if (!clientId) throw new Error('HH_CLIENT_ID обязателен');
  const u = new URL('https://hh.ru/oauth/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  if (process.env.HH_REDIRECT_URI) u.searchParams.set('redirect_uri', process.env.HH_REDIRECT_URI);
  return u.toString();
}
