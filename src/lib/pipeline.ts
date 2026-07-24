import type { SupabaseClient } from '@supabase/supabase-js';
import { processVetoQueue, sendApplication, latestLetter, type SendDeps } from './apply';
import { loadStyleExamples } from './curated';
import { letterTaskCfg, loadRuntimeConfig, scorerTaskCfg, type RuntimeConfig } from './config';
import { getDb, OWNER_ID } from './db';
import { addUsage, emptyTally, type TokenTally } from './cost';
import { buildDigest, type BriefItem } from './digest';
import { HHClient, hhUserAgent } from './hh';
import { generateLetter } from './letters';
import { createLLM } from './llm/client';
import { prefilter } from './prefilter';
import { loadProfileSmart, type Profile } from './profile';
import { createScorer, type Scorer } from './scorer';
import { computeSlots, selectForLimit, sendEligibility, type Candidate } from './selection';
import { syncNegotiations } from './sync';
import { formatCard, getTelegram, labelKeyboard, manualKeyboard, postSendKeyboard, vetoKeyboard, type Telegram } from './telegram';
import { formatViolations } from './validate-letter';
import { getAuthedHH, forceRefreshHH } from './tokens';
import { emptyRunStats, type EvaluationRow, type RunStats, type VacancyRow } from './types';
import { chunk, errorMessage, startOfDayInTz, stripHtml } from './util';
import {
  canSearch,
  canSend,
  modeChangeMessage,
  resolveRunMode,
  type RunMode,
} from './hh-health';
import { isFallback, withFallbackFlag } from './vacancy-add';

/** Ежедневный пайплайн (раздел 3.4 ТЗ). Запускается GitHub Actions в 03:00 и 15:00 UTC. */
export async function runPipeline(): Promise<RunStats> {
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const profile = await loadProfileSmart(db, cfg);
  const tg = getTelegram();
  const chatId = cfg.telegram.chat_id;
  const stats = emptyRunStats();
  const usage: TokenTally = emptyTally();

  const { data: runRow, error: runErr } = await db
    .from('runs')
    .insert({ user_id: OWNER_ID })
    .select('id')
    .single();
  if (runErr) throw new Error('runs insert: ' + runErr.message);
  const runId = runRow.id as string;

  const sentList: BriefItem[] = [];
  const queuedList: BriefItem[] = [];
  const manualList: BriefItem[] = [];
  const failedList: BriefItem[] = [];
  const followUps: BriefItem[] = [];
  let statusUpdates: string[] = [];

  try {
    const hhPublic = new HHClient({ userAgent: hhUserAgent() });
    let hhAuthed: HHClient | null = null;
    try {
      hhAuthed = await getAuthedHH(db);
    } catch {
      // OAuth может быть недоступен — итоговый режим определит health-check ниже
    }

    // v1.1: лесенка деградации hh — выбор режима прогона (спека 3.3, guardrail 10)
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
    stats.mode = health.mode;

    // Смена режима vs прошлый прогон → уведомление (возврат в FULL — автоматический)
    const { data: prevRun } = await db
      .from('runs')
      .select('stats')
      .eq('user_id', OWNER_ID)
      .neq('id', runId)
      .order('started_at', { ascending: false })
      .limit(1);
    const prevMode = ((prevRun?.[0]?.stats as { mode?: RunMode } | undefined)?.mode) ?? null;
    const changeMsg = modeChangeMessage(prevMode, health.mode);
    if (changeMsg && tg && chatId) await tg.sendMessage(chatId, changeMsg).catch(() => undefined);

    // Шаги 1–3: сбор, upsert (дедуп по hh id), детали для новых
    if (canSearch(health.mode) && health.searchClient) {
      await collectVacancies(db, health.searchClient, cfg, stats);
    } else {
      stats.errors.push('FALLBACK: hh-поиск недоступен, автосбор пропущен (используйте /add)');
    }

    // Шаг 4: детерминированный префильтр (без LLM)
    await runPrefilter(db, cfg, stats, manualList);

    if (!cfg.paused) {
      // Шаг 5: LLM-скоринг выживших (за интерфейсом Scorer — задача 6 слоя качества)
      await runScoring(db, createScorer(cfg, profile), cfg, stats, usage);
      // Шаг 6: письма для скора ≥ порога (модель уровнем выше — важно качество)
      await runLetters(db, createLLM(cfg, 'letters'), cfg, profile, stats, usage, tg);
    }

    const deps: SendDeps = { db, cfg, tg, hh: health.sendClient ?? undefined };

    if (canSend(health.mode) && health.sendClient) {
      // FULL: veto-очередь прошлого прогона + синк статусов ДО отправки
      // (синк раньше отправки защищает от двойных откликов — guardrail 3)
      const veto = await processVetoQueue(deps);
      stats.sent += veto.sent;
      stats.failed += veto.failed;
      try {
        statusUpdates = (await syncNegotiations(db, health.sendClient)).updates;
        stats.sync_updates = statusUpdates.length;
      } catch (e) {
        stats.errors.push('синк статусов: ' + errorMessage(e));
      }
      // Шаги 7–8: отбор в дневной лимит + отправка/очередь по режиму
      if (!cfg.paused) {
        await queueAndSend(db, cfg, deps, stats, sentList, queuedList, failedList, true);
      }
    } else if (!cfg.paused) {
      // NO_OAUTH / FALLBACK: без POST /negotiations — карточки ручного отклика (спека 3.6)
      await queueAndSend(db, cfg, deps, stats, sentList, queuedList, failedList, false);
    }

    await collectFollowUps(db, cfg, followUps);
  } catch (e) {
    stats.errors.push(errorMessage(e));
  }

  // Guardrail 6: логирование стоимости (скоринг и письма считаются по своим ценам — addUsage)
  const costRun = usage.costUsd;
  const todayStart = startOfDayInTz(cfg.timezone).toISOString();
  const { data: todayRuns } = await db
    .from('runs')
    .select('cost_usd')
    .eq('user_id', OWNER_ID)
    .gte('started_at', todayStart);
  const costToday =
    ((todayRuns ?? []) as { cost_usd: number }[]).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) + costRun;

  await db
    .from('runs')
    .update({
      finished_at: new Date().toISOString(),
      // задача 1: prompt_file/prompt_version/model/cost каждого LLM-вызова
      stats: { ...stats, llm_calls: usage.calls },
      tokens_in: usage.in,
      tokens_out: usage.out,
      cost_usd: costRun,
    })
    .eq('id', runId);

  // Шаг 10: дайджест в Telegram
  if (tg && chatId) {
    const runLabel = new Intl.DateTimeFormat('ru-RU', {
      timeZone: cfg.timezone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    const digest = buildDigest({
      runLabel,
      mode: cfg.sending.mode,
      hhMode: stats.mode,
      paused: cfg.paused,
      stats,
      sent: sentList,
      queued: queuedList,
      manual: manualList,
      failed: failedList,
      statusUpdates,
      followUps,
      tokensIn: usage.in,
      tokensOut: usage.out,
      costRun,
      costToday,
      costAlert: cfg.llm.daily_cost_alert_usd > 0 && costToday > cfg.llm.daily_cost_alert_usd,
    });
    await tg.sendMessage(chatId, digest).catch((e) => console.error('дайджест: ' + errorMessage(e)));
  }

  console.log('Прогон завершён:', JSON.stringify(stats));
  return stats;
}

async function collectVacancies(
  db: SupabaseClient,
  hh: HHClient,
  cfg: RuntimeConfig,
  stats: RunStats,
): Promise<string[]> {
  const newIds: string[] = [];
  for (const query of cfg.search.queries) {
    try {
      let page = 0;
      let pages = 1;
      while (page < pages && page < 19) {
        const res = await hh.searchVacancies({
          text: query,
          area: cfg.search.areas,
          order_by: 'publication_time',
          period: cfg.search.period_days,
          per_page: 100,
          page,
          ...(cfg.search.only_with_salary ? { only_with_salary: 'true' } : {}),
        });
        pages = res.pages;
        stats.collected += res.items.length;
        if (!res.items.length) break;

        const ids = res.items.map((i) => i.id);
        const { data: existing } = await db.from('vacancies').select('id').in('id', ids);
        const known = new Set(((existing ?? []) as { id: string }[]).map((r) => r.id));
        const fresh = res.items.filter((i) => !known.has(i.id));
        for (const item of fresh) {
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
          if (!error) newIds.push(item.id);
          else stats.errors.push(`upsert ${item.id}: ${error.message}`);
        }
        if (fresh.length === 0) break; // страница целиком из уже виденных — дальше только старое
        page++;
      }
    } catch (e) {
      stats.errors.push(`поиск «${query.slice(0, 40)}…»: ${errorMessage(e)}`);
    }
  }
  stats.new = newIds.length;

  // Шаг 3: детали только для новых
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
      stats.errors.push(`детали ${id}: ${errorMessage(e)}`);
    }
  }
  return newIds;
}

// Экспортируется для переиспользования дельта-поллингом (v1.2) — поведение не меняется.
export async function runPrefilter(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  stats: RunStats,
  manualList: BriefItem[],
): Promise<void> {
  // берём вакансии за 21 день, чтобы дообработать и те, что остались с упавших прогонов
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const { data: vacs } = await db.from('vacancies').select('*').gte('first_seen_at', since);
  const all = (vacs ?? []) as VacancyRow[];
  if (!all.length) return;

  const evaluated = new Set<string>();
  for (const part of chunk(all.map((v) => v.id), 200)) {
    const { data } = await db
      .from('evaluations')
      .select('vacancy_id')
      .eq('user_id', OWNER_ID)
      .in('vacancy_id', part);
    for (const r of (data ?? []) as { vacancy_id: string }[]) evaluated.add(r.vacancy_id);
  }

  for (const v of all) {
    if (evaluated.has(v.id)) continue;
    const verdict = prefilter(v, cfg);
    await db.from('evaluations').upsert(
      {
        vacancy_id: v.id,
        user_id: OWNER_ID,
        prefilter: verdict.passed ? 'passed' : `excluded:${verdict.reason}`,
      },
      { onConflict: 'vacancy_id,user_id' },
    );
    if (!verdict.passed) {
      stats.excluded++;
      if (verdict.reason?.startsWith('has_test')) {
        stats.manual_required++;
        manualList.push({ title: v.title, employer: v.employer });
      }
    }
  }
}

// Экспортируется для переиспользования дельта-поллингом (v1.2).
// Скоринг за интерфейсом Scorer (задача 6) — реализация подменяется без правки пайплайна.
export async function runScoring(
  db: SupabaseClient,
  scorer: Scorer,
  cfg: RuntimeConfig,
  stats: RunStats,
  usage: TokenTally,
): Promise<void> {
  const { data } = await db
    .from('evaluations')
    .select('vacancy_id')
    .eq('user_id', OWNER_ID)
    .eq('prefilter', 'passed')
    .is('score', null)
    .limit(cfg.llm.max_scores_per_run);
  const ids = ((data ?? []) as { vacancy_id: string }[]).map((r) => r.vacancy_id);
  if (!ids.length) return;

  const { data: vacs } = await db
    .from('vacancies')
    .select('*')
    .in('id', ids)
    .order('published_at', { ascending: false });
  for (const vac of (vacs ?? []) as VacancyRow[]) {
    try {
      const { result, usage: u, prompt } = await scorer.score(vac);
      addUsage(usage, u, scorerTaskCfg(cfg), {
        task: 'scoring',
        prompt_file: prompt.file,
        prompt_version: prompt.version,
        model: scorer.model,
      });
      await db
        .from('evaluations')
        .update({
          score: result.score,
          verdict: result.verdict,
          reasons: result.reasons,
          // fallback-вакансии (/add) сохраняют пометку о неполноте данных
          red_flags: isFallback(vac) ? withFallbackFlag(result.red_flags) : result.red_flags,
          resume_version: result.resume_version,
          letter_hook: result.letter_hook,
        })
        .eq('vacancy_id', vac.id)
        .eq('user_id', OWNER_ID);
      stats.scored++;
      if (result.score >= cfg.scoring.threshold) stats.above_threshold++;
    } catch (e) {
      stats.errors.push(`скоринг ${vac.id}: ${errorMessage(e)}`);
    }
  }
}

interface CandidateSets {
  rows: EvaluationRow[];
  /** Письмо готово к отправке: последняя версия НЕ needs_review. */
  withLetter: Set<string>;
  /** Есть хоть какое-то письмо (включая needs_review) — генерировать заново не нужно. */
  withAnyLetter: Set<string>;
  withApp: Set<string>;
  vacById: Map<string, VacancyRow>;
}

async function loadCandidateSets(db: SupabaseClient, cfg: RuntimeConfig): Promise<CandidateSets> {
  const { data: evs } = await db
    .from('evaluations')
    .select('*')
    .eq('user_id', OWNER_ID)
    .gte('score', cfg.scoring.threshold);
  const rows = (evs ?? []) as EvaluationRow[];
  const withLetter = new Set<string>();
  const withAnyLetter = new Set<string>();
  const withApp = new Set<string>();
  const vacById = new Map<string, VacancyRow>();
  for (const part of chunk(rows.map((r) => r.vacancy_id), 200)) {
    // письмо «готово», только если ПОСЛЕДНЯЯ версия не ждёт ручной проверки (needs_review)
    const { data: ls } = await db
      .from('letters')
      .select('vacancy_id, version, needs_review')
      .eq('user_id', OWNER_ID)
      .in('vacancy_id', part);
    const latest = new Map<string, { version: number; needs_review: boolean }>();
    for (const r of (ls ?? []) as { vacancy_id: string; version: number; needs_review: boolean | null }[]) {
      const cur = latest.get(r.vacancy_id);
      if (!cur || r.version > cur.version) {
        latest.set(r.vacancy_id, { version: r.version, needs_review: r.needs_review ?? false });
      }
    }
    for (const [id, l] of latest) {
      withAnyLetter.add(id);
      if (!l.needs_review) withLetter.add(id);
    }
    const { data: as } = await db
      .from('applications')
      .select('vacancy_id')
      .eq('user_id', OWNER_ID)
      .in('vacancy_id', part);
    for (const r of (as ?? []) as { vacancy_id: string }[]) withApp.add(r.vacancy_id);
    const { data: vs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vs ?? []) as VacancyRow[]) vacById.set(v.id, v);
  }
  return { rows, withLetter, withAnyLetter, withApp, vacById };
}

async function runLetters(
  db: SupabaseClient,
  llm: import('./llm/client').LLMClient,
  cfg: RuntimeConfig,
  profile: Profile,
  stats: RunStats,
  usage: TokenTally,
  tg: Telegram | null,
): Promise<void> {
  const { rows, withAnyLetter, withApp, vacById } = await loadCandidateSets(db, cfg);
  // задача 9: эталоны стиля (⭐) — few-shot только для писем; [] пока флаг off или пул < 3
  const styleExamples = await loadStyleExamples(db, cfg).catch(() => [] as string[]);
  let generated = 0;
  for (const ev of rows) {
    if (generated >= cfg.llm.max_letters_per_run) break;
    if (withAnyLetter.has(ev.vacancy_id) || withApp.has(ev.vacancy_id)) continue;
    const v = vacById.get(ev.vacancy_id);
    if (!v) continue;
    if (!sendEligibility(v, cfg.filters.max_vacancy_age_days).ok) continue;
    try {
      const res = await generateLetter(llm, cfg, profile, v, ev, styleExamples);
      addUsage(usage, res.usage, letterTaskCfg(cfg), {
        task: 'letter',
        prompt_file: res.prompt.file,
        prompt_version: res.prompt.version,
        model: llm.model,
      });
      await db.from('letters').insert({
        vacancy_id: ev.vacancy_id,
        user_id: OWNER_ID,
        text: res.text,
        version: 1,
        needs_review: res.needsReview,
      });
      generated++;
      if (res.needsReview) {
        // Задача 4: повторный провал детерминированного валидатора → needs_review + уведомление
        stats.letters_rejected++;
        stats.errors.push(`письмо ${ev.vacancy_id} → needs_review: ${formatViolations(res.violations.slice(0, 2))}`);
        if (tg && cfg.telegram.chat_id) {
          await tg
            .sendMessage(
              cfg.telegram.chat_id,
              `⚠️ Письмо требует ручной проверки: ${v.title} @ ${v.employer ?? '—'}\n` +
                `Нарушения: ${formatViolations(res.violations)}\n` +
                `Поправьте кнопкой ✏️ на карточке — после правки уйдёт в обычную очередь.`,
            )
            .catch(() => undefined);
        }
      } else {
        stats.lettered++;
      }
    } catch (e) {
      stats.errors.push(`письмо ${ev.vacancy_id}: ${errorMessage(e)}`);
    }
  }
}

async function queueAndSend(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  deps: SendDeps,
  stats: RunStats,
  sentList: BriefItem[],
  queuedList: BriefItem[],
  failedList: BriefItem[],
  canSendMode: boolean,
): Promise<void> {
  const { rows, withLetter, withApp, vacById } = await loadCandidateSets(db, cfg);

  // Кандидаты (раздел 3.5): письмо готово, отклика не было, скор ≥ порога, ≤14 дней, без теста
  const candidates: Candidate[] = [];
  for (const ev of rows) {
    if (!withLetter.has(ev.vacancy_id) || withApp.has(ev.vacancy_id)) continue;
    const v = vacById.get(ev.vacancy_id);
    if (!v) continue;
    if (!sendEligibility(v, cfg.filters.max_vacancy_age_days).ok) continue;
    candidates.push({ vacancy_id: ev.vacancy_id, score: ev.score ?? 0, published_at: v.published_at });
  }

  // Guardrail 4: жёсткий дневной лимит — вычитаем отправленное сегодня и всю текущую очередь
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
  const evByVac = new Map(rows.map((r) => [r.vacancy_id, r]));
  const tg = deps.tg;
  const chatId = cfg.telegram.chat_id;

  for (const cand of selected) {
    const v = vacById.get(cand.vacancy_id) as VacancyRow;
    const ev = evByVac.get(cand.vacancy_id) as EvaluationRow;
    const letter = await latestLetter(db, cand.vacancy_id);
    const resumeTitle =
      cfg.scoring.resume_versions[ev.resume_version ?? '']?.title ?? ev.resume_version ?? '—';

    if (!canSendMode) {
      // NO_OAUTH / FALLBACK: карточка ручного отклика; статус остаётся queued до
      // подтверждения кнопкой «✅ Я откликнулся». POST /negotiations не вызывается.
      const row: Record<string, unknown> = {
        vacancy_id: cand.vacancy_id,
        user_id: OWNER_ID,
        status: 'queued',
        queued_at: new Date().toISOString(),
      };
      if (tg && chatId) {
        try {
          const msg = await tg.sendMessage(
            chatId,
            formatCard(v, ev, letter?.text ?? null, resumeTitle),
            manualKeyboard(cand.vacancy_id),
          );
          row.tg_message_id = msg.message_id;
        } catch (e) {
          stats.errors.push('карточка tg: ' + errorMessage(e));
        }
      }
      await db.from('applications').upsert(row, { onConflict: 'vacancy_id,user_id' });
      stats.queued++;
      queuedList.push({ title: v.title, employer: v.employer, score: ev.score });
      continue;
    }

    if (cfg.sending.mode === 'autopilot') {
      // Отправка сразу, карточка приходит post-factum (раздел 3.6)
      await db.from('applications').upsert(
        { vacancy_id: cand.vacancy_id, user_id: OWNER_ID, status: 'queued', queued_at: new Date().toISOString() },
        { onConflict: 'vacancy_id,user_id' },
      );
      let res: { ok: boolean; error?: string };
      try {
        res = await sendApplication(deps, cand.vacancy_id);
      } catch (e) {
        res = { ok: false, error: errorMessage(e) };
      }
      if (res.ok) {
        stats.sent++;
        sentList.push({ title: v.title, employer: v.employer, score: ev.score });
      } else {
        stats.failed++;
        failedList.push({ title: v.title, employer: v.employer, note: res.error });
      }
      if (tg && chatId) {
        const prefix = res.ok ? '🤖 Отправлено автоматически\n' : `❌ Ошибка отправки: ${res.error}\n`;
        // метки 👍/👎 (задача 2) + «⭐ В эталоны» на отправленных письмах (задача 9)
        await tg
          .sendMessage(
            chatId,
            prefix + formatCard(v, ev, letter?.text ?? null, resumeTitle),
            res.ok ? postSendKeyboard(cand.vacancy_id) : labelKeyboard(cand.vacancy_id),
          )
          .catch(() => undefined);
      }
    } else {
      // review: ждёт кнопки; veto: отправится по таймауту, если нет реакции
      const row: Record<string, unknown> = {
        vacancy_id: cand.vacancy_id,
        user_id: OWNER_ID,
        status: 'queued',
        queued_at: new Date().toISOString(),
      };
      if (tg && chatId) {
        try {
          const msg = await tg.sendMessage(
            chatId,
            formatCard(v, ev, letter?.text ?? null, resumeTitle),
            vetoKeyboard(cand.vacancy_id),
          );
          row.tg_message_id = msg.message_id;
        } catch (e) {
          stats.errors.push('карточка tg: ' + errorMessage(e));
        }
      }
      await db.from('applications').upsert(row, { onConflict: 'vacancy_id,user_id' });
      stats.queued++;
      queuedList.push({ title: v.title, employer: v.employer, score: ev.score });
    }
  }
}

async function collectFollowUps(db: SupabaseClient, cfg: RuntimeConfig, followUps: BriefItem[]): Promise<void> {
  const cutoff = new Date(Date.now() - cfg.sending.followup_days * 86_400_000).toISOString();
  const { data } = await db
    .from('applications')
    .select('vacancy_id, sent_at, status')
    .eq('user_id', OWNER_ID)
    .in('status', ['sent', 'viewed'])
    .lt('sent_at', cutoff)
    .is('response_at', null)
    .limit(10);
  for (const r of (data ?? []) as { vacancy_id: string; sent_at: string | null; status: string }[]) {
    const { data: v } = await db.from('vacancies').select('title, employer').eq('id', r.vacancy_id).maybeSingle();
    const days = r.sent_at ? Math.floor((Date.now() - Date.parse(r.sent_at)) / 86_400_000) : 0;
    followUps.push({
      title: (v?.title as string | undefined) ?? r.vacancy_id,
      employer: v?.employer as string | undefined,
      note: `${days} дн. без ответа (${r.status})`,
    });
  }
}
