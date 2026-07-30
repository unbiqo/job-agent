import { scorerTaskCfg, loadRuntimeConfig } from './config';
import { addUsage, emptyTally, type TokenTally } from './cost';
import { getDb, OWNER_ID } from './db';
import { HHScraper, type ScrapedSearchItem, type ScrapedVacancy } from './hh-scrape';
import { prefilter } from './prefilter';
import { loadProfileSmart } from './profile';
import { fetchRemoteOkJobs, fetchWwrJobs, type RemoteJobCandidate } from './remote-sources';
import { createScorer } from './scorer';
import { selectForLimit, type Candidate } from './selection';
import { applySourceFilter } from './source-filters';
import { getTelegram } from './telegram';
import { emptyRunStats, type RunStats, type VacancyRow } from './types';
import { chunk, errorMessage } from './util';
import { responseLetterRequired } from './vacancy-letter';

/**
 * Scrape-дайджест (новое требование, api.hh.ru недоступен у владельца — 403):
 * несколько раз в день собираем скрапингом свежие вакансии, скорим и присылаем
 * ОДНИМ списком в Telegram; письмо генерируется по кнопке ✉️ (callback letter:).
 * Отклик — ручной: пользователь вставляет письмо на сайте hh.
 */

export interface ScrapeDigestOpts {
  dryRun?: boolean;
  /** Подмена скрапера для тестов. */
  scraper?: HHScraper;
}

interface DigestConfig {
  list_size: number;
  per_page: number;
  detail_limit: number;
}

type JobSourceId = 'hh' | 'remoteok' | 'wwr';
type AggregatedSearchItem = ScrapedSearchItem & {
  source: JobSourceId;
  description?: string | null;
  keySkills?: string[] | null;
  rawExtra?: Record<string, unknown>;
};

function digestCfg(cfg: { digest?: { list_size?: number; per_page?: number; detail_limit?: number } }): DigestConfig {
  return {
    list_size: cfg.digest?.list_size ?? 10,
    per_page: cfg.digest?.per_page ?? 50,
    detail_limit: cfg.digest?.detail_limit ?? 60,
  };
}

function appUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  if (prod) return (prod.startsWith('http') ? prod : `https://${prod}`).replace(/\/+$/, '');
  return '';
}

const POSITIVE_TERMS = [
  'ai',
  'ии',
  'llm',
  'rag',
  'gpt',
  'prompt',
  'промпт',
  'агент',
  'автоматизац',
  'python',
  'sql',
  'data',
  'данн',
  'аналит',
  'product',
  'продукт',
  'automation',
  'workflow',
];

const SOFT_NEGATIVE_TERMS = [
  'smm',
  'контент',
  'продюсер',
  'преподаватель',
  'методист',
  'продаж',
  'sales',
];

function freshnessScore(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 0;
  const ageHours = (Date.now() - Date.parse(publishedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return 0;
  if (ageHours <= 6) return 80;
  if (ageHours <= 24) return 60;
  if (ageHours <= 72) return 40;
  if (ageHours <= 168) return 20;
  return 0;
}

function keywordScore(text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const term of POSITIVE_TERMS) if (t.includes(term)) score += 8;
  for (const term of SOFT_NEGATIVE_TERMS) if (t.includes(term)) score -= 5;
  return Math.max(-20, Math.min(80, score));
}

function publishedMs(publishedAt: string | null | undefined): number {
  const t = publishedAt ? Date.parse(publishedAt) : 0;
  return Number.isFinite(t) ? t : 0;
}

function searchPriority(item: AggregatedSearchItem): number {
  return (
    freshnessScore(item.publishedAt) +
    keywordScore([item.title, item.employer ?? '', item.area ?? '', item.description ?? '', ...(item.keySkills ?? [])].join(' ')) +
    (item.scheduleId === 'remote' ? 8 : 0)
  );
}

function vacancyPriority(v: VacancyRow): number {
  const raw = (v.raw ?? {}) as { schedule?: { id?: string } };
  return (
    freshnessScore(v.published_at) +
    keywordScore([v.title, v.employer ?? '', v.description ?? '', ...(v.key_skills ?? [])].join(' ')) +
    (raw.schedule?.id === 'remote' ? 8 : 0) +
    (responseLetterRequired(v) === false ? 4 : 0)
  );
}

function sourceLabel(source: JobSourceId): string {
  if (source === 'remoteok') return 'Remote OK';
  if (source === 'wwr') return 'We Work Remotely';
  return 'hh';
}

function fromRemoteJob(job: RemoteJobCandidate): AggregatedSearchItem {
  return {
    id: job.id,
    source: job.source,
    title: job.title,
    url: job.url,
    employer: job.employer,
    area: job.area,
    salaryText: null,
    salary: job.salary,
    publishedAt: job.publishedAt,
    scheduleId: 'remote',
    description: job.description,
    keySkills: job.keySkills,
    rawExtra: job.raw,
  };
}

/** Сырая строка vacancies из карточки серпа (до загрузки деталей). */
function searchItemRow(item: AggregatedSearchItem): Record<string, unknown> {
  return {
    id: item.id,
    user_id: OWNER_ID,
    title: item.title,
    employer: item.employer,
    salary: item.salary,
    area: item.area,
    published_at: item.publishedAt,
    description: item.description ?? null,
    key_skills: item.keySkills ?? null,
    has_test: item.source === 'hh' ? null : false,
    raw: {
      source: item.source,
      source_label: sourceLabel(item.source),
      url: item.url,
      salary_text: item.salaryText,
      ...(item.rawExtra ?? {}),
      ...(item.scheduleId ? { schedule: { id: item.scheduleId } } : {}),
    },
  };
}

/** Патч vacancies после скрапинга страницы вакансии. */
function detailPatch(d: ScrapedVacancy, fallback: ScrapedSearchItem): Record<string, unknown> {
  return {
    title: d.title,
    employer: d.employer ?? fallback.employer,
    salary: d.salary ?? fallback.salary,
    published_at: d.publishedAt ?? fallback.publishedAt,
    description: d.description,
    key_skills: d.keySkills,
    has_test: d.hasTest ?? false,
    raw: {
      source: 'hh',
      source_label: 'hh',
      url: d.url,
      salary_text: d.salaryText ?? fallback.salaryText,
      experience: d.experience,
      address: d.address,
      publication_date: d.publishedAt,
      response_letter_required: d.responseLetterRequired,
      ...(d.remote ? { schedule: { id: 'remote' } } : fallback.scheduleId ? { schedule: { id: fallback.scheduleId } } : {}),
    },
  };
}

export async function runScrapeDigest(opts: ScrapeDigestOpts = {}): Promise<RunStats> {
  const dryRun = opts.dryRun ?? false;
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const profile = await loadProfileSmart(db, cfg);
  const tg = getTelegram();
  const chatId = cfg.telegram.chat_id;
  const dg = digestCfg(cfg);
  const stats = emptyRunStats();
  stats.kind = dryRun ? 'scrape-digest:dry' : 'scrape-digest';
  const usage: TokenTally = emptyTally();

  const { data: runRow, error: runErr } = await db
    .from('runs')
    .insert({ user_id: OWNER_ID })
    .select('id')
    .single();
  if (runErr) throw new Error('runs insert: ' + runErr.message);
  const runId = runRow.id as string;

  const scraper = opts.scraper ?? new HHScraper();
  // финальные строки списка: вакансия + скор
  const listed: { v: VacancyRow; score: number }[] = [];

  try {
    // Шаг 1: сбор карточек серпа по всем запросам, дедуп по id
    const byId = new Map<string, AggregatedSearchItem>();
    for (const query of cfg.search.queries) {
      try {
        const items = await scraper.scrapeSearch(query, { areas: cfg.search.areas, perPage: dg.per_page });
        stats.collected += items.length;
        for (const item of items) if (!byId.has(item.id)) byId.set(item.id, { ...item, source: 'hh' });
      } catch (e) {
        stats.errors.push(`скрапинг поиска «${query.slice(0, 40)}…»: ${errorMessage(e)}`);
      }
    }
    try {
      const remoteOk = await fetchRemoteOkJobs();
      stats.collected += remoteOk.length;
      for (const job of remoteOk) if (!byId.has(job.id)) byId.set(job.id, fromRemoteJob(job));
    } catch (e) {
      stats.errors.push(`Remote OK: ${errorMessage(e)}`);
    }
    try {
      const wwr = await fetchWwrJobs();
      stats.collected += wwr.length;
      for (const job of wwr) if (!byId.has(job.id)) byId.set(job.id, fromRemoteJob(job));
    } catch (e) {
      stats.errors.push(`We Work Remotely: ${errorMessage(e)}`);
    }
    const ids = [...byId.keys()];

    // Шаг 2: отбрасываем уже обработанные — есть отклик/показ в списке (applications),
    // письмо (letters) или оценка (evaluations) — повторно не показываем
    const busy = new Set<string>();
    for (const part of chunk(ids, 200)) {
      const [apps, letters, evals] = await Promise.all([
        db.from('applications').select('vacancy_id').eq('user_id', OWNER_ID).in('vacancy_id', part),
        db.from('letters').select('vacancy_id').eq('user_id', OWNER_ID).in('vacancy_id', part),
        db.from('evaluations').select('vacancy_id').eq('user_id', OWNER_ID).in('vacancy_id', part),
      ]);
      for (const r of (apps.data ?? []) as { vacancy_id: string }[]) busy.add(r.vacancy_id);
      for (const r of (letters.data ?? []) as { vacancy_id: string }[]) busy.add(r.vacancy_id);
      for (const r of (evals.data ?? []) as { vacancy_id: string }[]) busy.add(r.vacancy_id);
    }
    const fresh = ids.filter((id) => !busy.has(id));
    stats.new = fresh.length;

    const { data: existing } = fresh.length
      ? await db.from('vacancies').select('id').in('id', fresh)
      : { data: [] as { id: string }[] };
    const existingIds = new Set(((existing ?? []) as { id: string }[]).map((r) => r.id));

    // Шаг 3: префильтр по данным серпа (без описания); отсеянным — evaluations
    const passedIds: string[] = [];
    for (const id of fresh) {
      const item = byId.get(id) as AggregatedSearchItem;
      if (!existingIds.has(id)) {
        const { error } = await db.from('vacancies').upsert(searchItemRow(item), { onConflict: 'id' });
        if (error) {
          stats.errors.push(`upsert ${id}: ${error.message}`);
          continue;
        }
      }
      const v = {
        title: item.title,
        employer: item.employer,
        description: null,
        area: item.area,
        key_skills: item.keySkills ?? null,
        salary: item.salary,
        published_at: item.publishedAt,
        has_test: null,
        raw: searchItemRow(item).raw as Record<string, unknown>,
      };
      const sourceVerdict = applySourceFilter(
        {
          source: item.source,
          title: item.title,
          employer: item.employer,
          area: item.area,
          description: item.description ?? null,
          key_skills: item.keySkills ?? null,
          salary: item.salary,
          published_at: item.publishedAt,
          raw: searchItemRow(item).raw as Record<string, unknown>,
        },
        cfg.source_filters,
      );
      if (!sourceVerdict.passed) {
        await db.from('evaluations').upsert(
          { vacancy_id: id, user_id: OWNER_ID, prefilter: `excluded:source:${sourceVerdict.reason}` },
          { onConflict: 'vacancy_id,user_id' },
        );
        stats.excluded++;
        continue;
      }
      const verdict = prefilter(v, cfg);
      if (!verdict.passed) {
        await db.from('evaluations').upsert(
          { vacancy_id: id, user_id: OWNER_ID, prefilter: `excluded:${verdict.reason}` },
          { onConflict: 'vacancy_id,user_id' },
        );
        stats.excluded++;
        continue;
      }
      passedIds.push(id);
    }

    const detailLimit = Math.max(dg.detail_limit, cfg.llm.max_scores_per_run, dg.list_size);
    const detailIds = [...passedIds]
      .sort((a, b) => {
        const ai = byId.get(a) as AggregatedSearchItem;
        const bi = byId.get(b) as AggregatedSearchItem;
        return searchPriority(bi) - searchPriority(ai) || publishedMs(bi.publishedAt) - publishedMs(ai.publishedAt);
      })
      .slice(0, detailLimit);

    // Шаг 4: детали страниц вакансий + повторный префильтр на полных данных
    const fullRows = new Map<string, VacancyRow>();
    for (const id of detailIds) {
      const item = byId.get(id) as AggregatedSearchItem;
      if (item.source === 'hh') {
      try {
        const d = await scraper.scrapeVacancy(id);
        const { error } = await db.from('vacancies').update(detailPatch(d, item)).eq('id', id);
        if (error) stats.errors.push(`детали ${id}: ${error.message}`);
      } catch (e) {
        stats.errors.push(`скрапинг вакансии ${id}: ${errorMessage(e)}`);
      }
      }
      const { data: row } = await db.from('vacancies').select('*').eq('id', id).maybeSingle();
      const v = row as VacancyRow | null;
      if (!v) continue;
      const rawSource = String(v.raw?.source ?? item.source) as JobSourceId;
      const sourceVerdict = applySourceFilter(
        {
          source: rawSource === 'remoteok' || rawSource === 'wwr' ? rawSource : 'hh',
          title: v.title,
          employer: v.employer,
          area: v.area,
          description: v.description,
          key_skills: v.key_skills,
          salary: v.salary,
          published_at: v.published_at,
          raw: v.raw,
        },
        cfg.source_filters,
      );
      if (!sourceVerdict.passed) {
        await db.from('evaluations').upsert(
          {
            vacancy_id: id,
            user_id: OWNER_ID,
            prefilter: `excluded:source:${sourceVerdict.reason}`,
          },
          { onConflict: 'vacancy_id,user_id' },
        );
        stats.excluded++;
        continue;
      }
      const verdict = prefilter(v, cfg);
      if (!verdict.passed) {
        await db.from('evaluations').upsert(
          {
            vacancy_id: id,
            user_id: OWNER_ID,
            prefilter: `excluded:${verdict.reason}`,
          },
          { onConflict: 'vacancy_id,user_id' },
        );
        stats.excluded++;
        continue;
      }
      fullRows.set(id, v);
    }

    const ranked = [...fullRows.values()]
      .map((v) => ({ v, priority: vacancyPriority(v) }))
      .sort((a, b) => b.priority - a.priority || publishedMs(b.v.published_at) - publishedMs(a.v.published_at));

    // Шаг 5: LLM-скоринг только priority top-N
    if (!cfg.paused) {
      const scorer = createScorer(cfg, profile);
      let scored = 0;
      for (const { v } of ranked.slice(0, cfg.llm.max_scores_per_run)) {
        const id = v.id;
        if (scored >= cfg.llm.max_scores_per_run) break;
        try {
          const { result, usage: u, prompt } = await scorer.score(v);
          addUsage(usage, u, scorerTaskCfg(cfg), {
            task: 'scoring',
            prompt_file: prompt.file,
            prompt_version: prompt.version,
            model: scorer.model,
          });
          await db.from('evaluations').upsert(
            {
              vacancy_id: id,
              user_id: OWNER_ID,
              prefilter: 'passed',
              score: result.score,
              verdict: result.verdict,
              reasons: result.reasons,
              red_flags: result.red_flags,
              resume_version: result.resume_version,
              letter_hook: result.letter_hook,
            },
            { onConflict: 'vacancy_id,user_id' },
          );
          stats.scored++;
          scored++;
          if (result.score >= cfg.scoring.threshold) {
            stats.above_threshold++;
            listed.push({ v, score: result.score });
          }
        } catch (e) {
          stats.errors.push(`скоринг ${id}: ${errorMessage(e)}`);
        }
      }
    }

    // Шаг 6: top для main inbox только из LLM-релевантных вакансий
    const candidates: Candidate[] = listed.map((x) => ({
      vacancy_id: x.v.id,
      score: x.score,
      published_at: x.v.published_at,
    }));
    const selected = selectForLimit(candidates, dg.list_size);
    const byIdListed = new Map(listed.map((x) => [x.v.id, x]));
    const top = selected
      .map((c) => byIdListed.get(c.vacancy_id) as { v: VacancyRow; score: number } | undefined)
      .filter((x): x is { v: VacancyRow; score: number } => Boolean(x));

    // Шаг 7: Telegram только уведомляет. Подробный просмотр и генерация писем — в web inbox.
    const inbox = appUrl();
    const text = top.length
      ? [`Найдено новых вакансий в inbox: ${top.length}.`, inbox ? `Открыть inbox: ${inbox}` : 'Откройте web inbox, чтобы посмотреть описания.'].join('\n')
      : 'Скрапинг hh: новых вакансий не нашлось.';
    const keyboard =
      top.length && inbox
        ? { inline_keyboard: [[{ text: 'Открыть inbox', url: inbox }]] }
        : undefined;

    if (dryRun) {
      console.log('[dry-run] Сообщение НЕ отправлено, applications не пишутся. Текст:\n' + text);
    } else if (tg && chatId) {
      let messageId: number | null = null;
      try {
        const msg = await tg.sendMessage(chatId, text, keyboard);
        messageId = msg.message_id;
      } catch (e) {
        stats.errors.push('список tg: ' + errorMessage(e));
      }
      // помечаем показанные, чтобы не присылать повторно
      for (const x of top) {
        const { error } = await db.from('applications').upsert(
          {
            vacancy_id: x.v.id,
            user_id: OWNER_ID,
            status: 'listed',
            manual: true,
            tg_message_id: messageId,
          },
          { onConflict: 'vacancy_id,user_id' },
        );
        if (error) stats.errors.push(`listed ${x.v.id}: ${error.message}`);
      }
      stats.queued = top.length;
    }
  } catch (e) {
    stats.errors.push(errorMessage(e));
  }

  await db
    .from('runs')
    .update({
      finished_at: new Date().toISOString(),
      stats: { ...stats, llm_calls: usage.calls },
      tokens_in: usage.in,
      tokens_out: usage.out,
      cost_usd: usage.costUsd,
    })
    .eq('id', runId);

  console.log('Scrape-дайджест завершён:', JSON.stringify(stats));
  return stats;
}
