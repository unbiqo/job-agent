import type { RuntimeConfig } from './config';
import { HHError, type HHClient } from './hh';

// v1.1: лесенка деградации hh (спека 3.3, guardrail 10).
export type RunMode = 'FULL' | 'NO_OAUTH' | 'FALLBACK';
export type HHFailure = 'ip_block' | 'expired_token' | 'temporary' | 'forbidden' | 'other';

// Минимальные структурные интерфейсы — HHClient им удовлетворяет, а тесты
// могут подставлять лёгкие моки без реальной сети.
export interface SearchClient {
  searchVacancies(query: Record<string, string | number | boolean | string[] | undefined>): Promise<unknown>;
}
export interface OAuthClient {
  getMyResumes(): Promise<unknown>;
}

/**
 * Классификация ошибки hh:
 *  403 {"type":"forbidden"} → IP-блок (при поиске повторяем с OAuth-токеном);
 *  401 → протухший токен (одна попытка refresh);
 *  5xx / сетевой сбой / timeout → временная недоступность.
 */
export function classifyHHError(e: unknown): HHFailure {
  if (e instanceof HHError) {
    if (e.status === 403) {
      try {
        const body = JSON.parse(e.body) as { type?: string; errors?: { type?: string; value?: string }[] };
        const markers = [body.type, ...(body.errors ?? []).flatMap((x) => [x.type, x.value])];
        if (markers.includes('forbidden')) return 'ip_block';
      } catch {
        /* тело не JSON — трактуем как обычный forbidden ниже */
      }
      return 'forbidden';
    }
    if (e.status === 401) return 'expired_token';
    if (e.status >= 500) return 'temporary';
    return 'other';
  }
  return 'temporary'; // network error / timeout
}

export interface SearchHealth {
  ok: boolean;
  usedOAuth: boolean;
  failure?: HHFailure;
}

/** check_search: GET /vacancies?per_page=1. При 403 IP-блоке повторяет запрос с OAuth-токеном. */
export async function checkSearch<T extends SearchClient>(pub: T, authed?: T | null): Promise<SearchHealth> {
  try {
    await pub.searchVacancies({ per_page: 1 });
    return { ok: true, usedOAuth: false };
  } catch (e) {
    const failure = classifyHHError(e);
    if (failure === 'ip_block' && authed) {
      try {
        await authed.searchVacancies({ per_page: 1 });
        return { ok: true, usedOAuth: true };
      } catch (e2) {
        return { ok: false, usedOAuth: true, failure: classifyHHError(e2) };
      }
    }
    return { ok: false, usedOAuth: false, failure };
  }
}

export interface OAuthHealth<T> {
  ok: boolean;
  failure?: HHFailure;
  refreshed: boolean;
  client: T | null;
}

/** check_oauth: GET /resumes/mine. При 401 — одна попытка refresh через переданный колбэк. */
export async function checkOAuth<T extends OAuthClient>(
  authed: T | null,
  refresh?: () => Promise<T | null>,
): Promise<OAuthHealth<T>> {
  if (!authed) return { ok: false, failure: 'other', refreshed: false, client: null };
  try {
    await authed.getMyResumes();
    return { ok: true, refreshed: false, client: authed };
  } catch (e) {
    const failure = classifyHHError(e);
    if (failure === 'expired_token' && refresh) {
      const fresh = await refresh().catch(() => null);
      if (fresh) {
        try {
          await fresh.getMyResumes();
          return { ok: true, refreshed: true, client: fresh };
        } catch (e2) {
          return { ok: false, failure: classifyHHError(e2), refreshed: true, client: null };
        }
      }
    }
    return { ok: false, failure, refreshed: false, client: null };
  }
}

export function deriveMode(searchOk: boolean, oauthOk: boolean): RunMode {
  if (!searchOk) return 'FALLBACK';
  return oauthOk ? 'FULL' : 'NO_OAUTH';
}

export function canSend(mode: RunMode): boolean {
  return mode === 'FULL';
}
export function canSearch(mode: RunMode): boolean {
  return mode !== 'FALLBACK';
}

const MODE_LABEL: Record<RunMode, string> = {
  FULL: 'FULL — поиск и отклики работают',
  NO_OAUTH: 'NO_OAUTH — поиск работает, отклики вручную (нет OAuth)',
  FALLBACK: 'FALLBACK — hh-поиск недоступен, добавляйте вакансии через /add',
};

/** Сообщение о смене режима; null, если режим не изменился или прошлого прогона не было. */
export function modeChangeMessage(prev: RunMode | null, next: RunMode): string | null {
  if (prev === null || prev === next) return null;
  const arrow = next === 'FULL' ? '✅' : '⚠️';
  return `${arrow} Режим hh: ${prev} → ${next}\n${MODE_LABEL[next]}`;
}

export interface HealthResult {
  mode: RunMode;
  searchClient: HHClient | null; // клиент для сбора /vacancies (public или OAuth при IP-блоке)
  sendClient: HHClient | null; // рабочий OAuth-клиент для откликов/синка, либо null
  detail: string;
}

export interface ResolveDeps {
  cfg: RuntimeConfig;
  hhPublic: HHClient;
  hhAuthed: HHClient | null;
  refreshAuthed?: () => Promise<HHClient | null>;
}

/**
 * Выбор режима прогона. hh.mode из настроек: auto (детект по health-check) |
 * full | no_oauth | fallback (принудительно). Возврат в FULL из деградации —
 * автоматический, как только health-check снова проходит.
 */
export async function resolveRunMode(deps: ResolveDeps): Promise<HealthResult> {
  const forced = deps.cfg.hh?.mode ?? 'auto';
  if (forced === 'full') return { mode: 'FULL', searchClient: deps.hhPublic, sendClient: deps.hhAuthed, detail: 'forced full' };
  if (forced === 'no_oauth') return { mode: 'NO_OAUTH', searchClient: deps.hhPublic, sendClient: null, detail: 'forced no_oauth' };
  if (forced === 'fallback') return { mode: 'FALLBACK', searchClient: null, sendClient: null, detail: 'forced fallback' };

  const s = await checkSearch(deps.hhPublic, deps.hhAuthed);
  if (!s.ok) return { mode: 'FALLBACK', searchClient: null, sendClient: null, detail: `search недоступен (${s.failure})` };
  const searchClient = s.usedOAuth && deps.hhAuthed ? deps.hhAuthed : deps.hhPublic;

  const o = await checkOAuth(deps.hhAuthed, deps.refreshAuthed);
  const mode = deriveMode(true, o.ok);
  return {
    mode,
    searchClient,
    sendClient: o.ok ? (o.client as HHClient) : null,
    detail: `search ${s.usedOAuth ? 'via oauth' : 'public'}; oauth ${o.ok ? 'ok' : o.failure}`,
  };
}
