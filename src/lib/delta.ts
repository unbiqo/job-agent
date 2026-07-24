import type { SupabaseClient } from '@supabase/supabase-js';
import { latestLetter, sendApplication, type SendDeps } from './apply';
import { letterTaskCfg, loadRuntimeConfig, type RuntimeConfig } from './config';
import { addUsage, emptyTally, type TokenTally } from './cost';
import { loadStyleExamples } from './curated';
import { getDb, OWNER_ID } from './db';
import { canSearch, canSend, resolveRunMode } from './hh-health';
import { HHClient, hhUserAgent } from './hh';
import { generateLetter } from './letters';
import { createLLM } from './llm/client';
import { runPrefilter, runScoring } from './pipeline';
import { loadProfileSmart } from './profile';
import { createScorer } from './scorer';
import { computeSlots, dedupeNewIds, selectForLimit, sendEligibility, type Candidate } from './selection';
import { formatCard, getTelegram, labelKeyboard, manualKeyboard, postSendKeyboard, statusPollKeyboard, type Telegram } from './telegram';
import { formatViolations } from './validate-letter';
import { getAuthedHH, forceRefreshHH } from './tokens';
import { emptyRunStats, type ApplicationRow, type EvaluationRow, type RunStats, type VacancyRow } from './types';
import { chunk, errorMessage, startOfDayInTz, stripHtml } from './util';

interface DeltaCfg {
  enabled: boolean;
  interval_min: number;
  hot_threshold: number;
}

function deltaCfg(cfg: RuntimeConfig): DeltaCfg {
  const dp = cfg.delta_poll ?? {};
  return {
    enabled: dp.enabled ?? false,
    interval_min: dp.interval_min ?? 30,
    hot_threshold: dp.hot_threshold ?? 8,
  };
}

/** Окно активности дельта-поллинга: 06:00–01:00 МСК (спека 3.4а). */
export function withinActivityWindow(tz: string, now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now).slice(0, 2));
  return h >= 6 || h < 1; // активно 06:00..23:59 и в 00:xx; неактивно 01:00..05:59
}

async function lastDeltaAt(db: SupabaseClient): Promise<number | null> {
  const { data } = await db
    .from('runs')
    .select('started_at, stats')
    .eq('user_id', OWNER_ID)
    .order('started_at', { ascending: false })
    .limit(20);
  for (const r of (data ?? []) as { started_at: string; stats: { kind?: string } | null }[]) {
    if (r.stats?.kind === 'delta') return Date.parse(r.started_at);
  }
  return null;
}

/** Дельта-сбор: period=1, per_page=20, одна страница, только новые id (без дублей). */
async function collectDelta(db: SupabaseClient, hh: HHClient, cfg: RuntimeConfig, stats: RunStats): Promise<string[]> {
  const newIds: string[] = [];
  for (const query of cfg.search.queries) {
    try {
      const res = await hh.searchVacancies({
        text: query,
        area: cfg.search.areas,
        order_by: 'publication_time',
        period: 1,
        per_page: 20,
        page: 0,
        ...(cfg.search.only_with_salary ? { only_with_salary: 'true' } : {}),
      });
      stats.collected += res.items.length;
      const ids = res.items.map((i) => i.id);
      const { data: existing } = await db.from('vacancies').select('id').in('id', ids);
      const known = new Set(((existing ?? []) as { id: string }[]).map((r) => r.id));
      const byId = new Map(res.items.map((i) => [i.id, i]));
      for (const id of dedupeNewIds(ids, known)) {
        const item = byId.get(id);
        if (!item) continue;
        const { error } = await db.from('vacancies').upsert(
          {
            id: item.id,
            user_id: OWNER_ID,
            title: item.name,
            employer: item.employer?.name ?? null,
            salary: item.salary ?? null,
            area: item.area?.name ?? null,
            published_at: item.published_at ?? null,
            has_test: item.has_test ?? null,
            raw: item,
          },
          { onConflict: 'id' },
        );
        if (!error) newIds.push(id);
        else stats.errors.push(`delta upsert ${id}: ${error.message}`);
      }
    } catch (e) {
      stats.errors.push(`delta «${query.slice(0, 40)}…»: ${errorMessage(e)}`);
    }
  }
  stats.new = newIds.length;

  for (const id of newIds) {
    try {
      const d = await hh.getVacancy(id);
      await db
        .from('vacancies')
        .update({
          description: d.description ? stripHtml(d.description) : null,
          key_skills: (d.key_skills ?? []).map((k) => k.name),
          has_test: d.has_test ?? false,
          salary: d.salary ?? null,
          raw: d,
        })
        .eq('id', id);
    } catch (e) {
      stats.errors.push(`delta детали ${id}: ${errorMessage(e)}`);
    }
  }
  return newIds;
}

/**
 * Дельта-поллинг (спека 3.4а): частый лёгкий проход в окне активности.
 * Горячие вакансии (score ≥ hot_threshold) — письмо и отправка/карточка сразу;
 * 7–8 остаются оценёнными и уходят в очередь большого прогона. Расходует ОБЩИЙ
 * дневной лимит. Вызывается из veto-sweep каждые 30 минут.
 */
export async function runDeltaPoll(): Promise<void> {
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const dp = deltaCfg(cfg);
  if (!dp.enabled) {
    console.log('delta: выключен (delta_poll.enabled=false)');
    return;
  }
  if (cfg.paused) {
    console.log('delta: пропуск (пауза)');
    return;
  }
  if (!withinActivityWindow(cfg.timezone)) {
    console.log('delta: вне окна активности 06:00–01:00');
    return;
  }
  const last = await lastDeltaAt(db);
  if (last && Date.now() - last < dp.interval_min * 60_000) {
    console.log('delta: интервал ещё не истёк');
    return;
  }

  const hhPublic = new HHClient({ userAgent: hhUserAgent() });
  let hhAuthed: HHClient | null = null;
  try {
    hhAuthed = await getAuthedHH(db);
  } catch {
    /* режим определит health-check */
  }
  const health = await resolveRunMode({
    cfg,
    hhPublic,
    hhAuthed,
    refreshAuthed: async () => {
      try {
        return await forceRefreshHH(db);
      } catch {
        return null;
      }
    },
  });

  const stats = emptyRunStats();
  stats.mode = health.mode;
  stats.kind = 'delta';
  const usage: TokenTally = emptyTally();

  const { data: runRow } = await db.from('runs').insert({ user_id: OWNER_ID }).select('id').single();
  const runId = runRow?.id as string | undefined;

  try {
    if (!canSearch(health.mode) || !health.searchClient) {
      console.log(`delta: поиск недоступен (${health.mode})`);
    } else {
      const profile = await loadProfileSmart(db, cfg);
      await collectDelta(db, health.searchClient, cfg, stats);
      await runPrefilter(db, cfg, stats, []);
      await runScoring(db, createScorer(cfg, profile), cfg, stats, usage);
      await sendHot(db, cfg, dp, health.sendClient, health.mode, stats, usage, createLLM(cfg, 'letters'), profile);
    }
  } catch (e) {
    stats.errors.push(errorMessage(e));
  }

  const costRun = usage.costUsd;
  if (runId) {
    await db
      .from('runs')
      .update({
        finished_at: new Date().toISOString(),
        stats: { ...stats, llm_calls: usage.calls },
        tokens_in: usage.in,
        tokens_out: usage.out,
        cost_usd: costRun,
      })
      .eq('id', runId);
  }
  console.log('delta-прогон:', JSON.stringify({ mode: stats.mode, new: stats.new, hot_sent: stats.sent, hot_queued: stats.queued }));
}

async function sendHot(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  dp: DeltaCfg,
  sendClient: HHClient | null,
  mode: import('./hh-health').RunMode,
  stats: RunStats,
  usage: TokenTally,
  llm: ReturnType<typeof createLLM>,
  profile: Awaited<ReturnType<typeof loadProfileSmart>>,
): Promise<void> {
  const tg = getTelegram();
  const chatId = cfg.telegram.chat_id;

  const { data: evs } = await db
    .from('evaluations')
    .select('*')
    .eq('user_id', OWNER_ID)
    .gte('score', dp.hot_threshold);
  const evRows = (evs ?? []) as EvaluationRow[];
  if (!evRows.length) return;

  const ids = evRows.map((r) => r.vacancy_id);
  const withLetter = new Set<string>();
  const withApp = new Set<string>();
  const vacById = new Map<string, VacancyRow>();
  for (const part of chunk(ids, 200)) {
    const { data: ls } = await db.from('letters').select('vacancy_id').eq('user_id', OWNER_ID).in('vacancy_id', part);
    for (const r of (ls ?? []) as { vacancy_id: string }[]) withLetter.add(r.vacancy_id);
    const { data: as } = await db.from('applications').select('vacancy_id').eq('user_id', OWNER_ID).in('vacancy_id', part);
    for (const r of (as ?? []) as { vacancy_id: string }[]) withApp.add(r.vacancy_id);
    const { data: vs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vs ?? []) as VacancyRow[]) vacById.set(v.id, v);
  }

  const candidates: Candidate[] = [];
  for (const ev of evRows) {
    if (withLetter.has(ev.vacancy_id) || withApp.has(ev.vacancy_id)) continue;
    const v = vacById.get(ev.vacancy_id);
    if (!v) continue;
    if (!sendEligibility(v, cfg.filters.max_vacancy_age_days).ok) continue;
    candidates.push({ vacancy_id: ev.vacancy_id, score: ev.score ?? 0, published_at: v.published_at });
  }
  if (!candidates.length) return;

  // Общий дневной лимит (guardrail 4) — та же формула, что и в большом прогоне
  const todayStart = startOfDayInTz(cfg.timezone).toISOString();
  const { count: sentToday } = await db
    .from('applications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .gte('sent_at', todayStart);
  const { count: queuedNow } = await db
    .from('applications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .eq('status', 'queued');
  const slots = computeSlots(cfg.sending.daily_cap, sentToday ?? 0, queuedNow ?? 0);
  const selected = selectForLimit(candidates, slots);
  const evByVac = new Map(evRows.map((r) => [r.vacancy_id, r]));
  const deps: SendDeps = { db, cfg, tg, hh: sendClient ?? undefined };
  const styleExamples = await loadStyleExamples(db, cfg).catch(() => [] as string[]);

  for (const cand of selected) {
    const v = vacById.get(cand.vacancy_id) as VacancyRow;
    const ev = evByVac.get(cand.vacancy_id) as EvaluationRow;
    let text: string | null = null;
    try {
      const res = await generateLetter(llm, cfg, profile, v, ev, styleExamples);
      addUsage(usage, res.usage, letterTaskCfg(cfg), {
        task: 'letter',
        prompt_file: res.prompt.file,
        prompt_version: res.prompt.version,
        model: llm.model,
      });
      text = res.text;
      await db.from('letters').upsert(
        { vacancy_id: cand.vacancy_id, user_id: OWNER_ID, text, version: 1, needs_review: res.needsReview },
        { onConflict: 'vacancy_id,user_id,version' },
      );
      if (res.needsReview) {
        // задача 4: письмо не прошло валидатор дважды → ручная проверка, не отправляем
        stats.letters_rejected++;
        if (tg && chatId) {
          await tg
            .sendMessage(
              chatId,
              `⚠️ Горячая вакансия, но письмо требует ручной проверки: ${v.title} @ ${v.employer ?? '—'}\n` +
                `Нарушения: ${formatViolations(res.violations)}`,
            )
            .catch(() => undefined);
        }
        continue;
      }
      stats.lettered++;
    } catch (e) {
      stats.errors.push(`delta письмо ${cand.vacancy_id}: ${errorMessage(e)}`);
      continue;
    }

    const resumeTitle = cfg.scoring.resume_versions[ev.resume_version ?? '']?.title ?? '—';
    if (canSend(mode) && sendClient) {
      await db
        .from('applications')
        .upsert({ vacancy_id: cand.vacancy_id, user_id: OWNER_ID, status: 'queued', queued_at: new Date().toISOString() }, { onConflict: 'vacancy_id,user_id' });
      const res = await sendApplication(deps, cand.vacancy_id);
      if (res.ok) {
        stats.sent++;
        if (tg && chatId)
          await tg
            .sendMessage(chatId, '🔥 Горячая вакансия отправлена\n' + formatCard(v, ev, text, resumeTitle), postSendKeyboard(cand.vacancy_id))
            .catch(() => undefined);
      } else {
        stats.failed++;
        if (tg && chatId)
          await tg
            .sendMessage(chatId, `❌ Горячая: ошибка отправки — ${res.error}\n` + formatCard(v, ev, text, resumeTitle), labelKeyboard(cand.vacancy_id))
            .catch(() => undefined);
      }
    } else {
      const row: Record<string, unknown> = {
        vacancy_id: cand.vacancy_id,
        user_id: OWNER_ID,
        status: 'queued',
        queued_at: new Date().toISOString(),
      };
      if (tg && chatId) {
        try {
          const msg = await tg.sendMessage(chatId, '🔥 Горячая вакансия\n' + formatCard(v, ev, text, resumeTitle), manualKeyboard(cand.vacancy_id));
          row.tg_message_id = msg.message_id;
        } catch (e) {
          stats.errors.push('карточка tg: ' + errorMessage(e));
        }
      }
      await db.from('applications').upsert(row, { onConflict: 'vacancy_id,user_id' });
      stats.queued++;
    }
  }
}

/**
 * 3-дневный опрос статуса ручных откликов (спека 3.7): когда синк по OAuth
 * недоступен, спрашиваем владельца об откликах без движения. Раз в 3 дня на отклик.
 */
export async function runStatusPoll(deps: { db: SupabaseClient; cfg: RuntimeConfig; tg: Telegram | null }): Promise<number> {
  const { db, cfg, tg } = deps;
  const chatId = cfg.telegram.chat_id;
  if (!tg || !chatId) return 0;

  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data } = await db
    .from('applications')
    .select('*')
    .eq('user_id', OWNER_ID)
    .eq('status', 'sent')
    .eq('manual', true)
    .is('response_at', null)
    .lt('sent_at', threeDaysAgo)
    .limit(20);
  const rows = (data ?? []) as ApplicationRow[];

  let polled = 0;
  for (const r of rows) {
    if (polled >= 5) break;
    if (r.polled_at && Date.now() - Date.parse(r.polled_at) < 3 * 86_400_000) continue;
    const { data: v } = await db.from('vacancies').select('title, employer').eq('id', r.vacancy_id).maybeSingle();
    const label = v ? `${v.title} @ ${v.employer ?? '—'}` : r.vacancy_id;
    const days = r.sent_at ? Math.floor((Date.now() - Date.parse(r.sent_at)) / 86_400_000) : 0;
    await tg
      .sendMessage(chatId, `📊 ${label}\nОтклик отправлен ${days} дн. назад, статус неизвестен. Что нового?`, statusPollKeyboard(r.vacancy_id))
      .catch(() => undefined);
    await db.from('applications').update({ polled_at: new Date().toISOString() }).eq('vacancy_id', r.vacancy_id).eq('user_id', OWNER_ID);
    polled++;
  }
  return polled;
}
