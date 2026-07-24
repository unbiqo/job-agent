import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeConfig } from './config';
import { OWNER_ID } from './db';
import { HHError, type HHClient } from './hh';
import { sendEligibility } from './selection';
import { labelKeyboard, postSendKeyboard, type Telegram } from './telegram';
import { getAuthedHH } from './tokens';
import type { ApplicationRow, EvaluationRow, LetterRow, VacancyRow } from './types';
import { errorMessage } from './util';

export interface SendDeps {
  db: SupabaseClient;
  cfg: RuntimeConfig;
  tg: Telegram | null;
  hh?: HHClient;
}

const ALREADY_SENT_STATUSES = ['sent', 'viewed', 'invited', 'rejected', 'offer'];

function hhErrorText(e: unknown): string {
  if (e instanceof HHError) {
    try {
      const body = JSON.parse(e.body) as { errors?: { type?: string; value?: string }[]; description?: string };
      const values = (body.errors ?? []).map((x) => x.value ?? x.type).filter(Boolean) as string[];
      const map: Record<string, string> = {
        already_applied: 'уже откликался на эту вакансию',
        test_required: 'требуется тест — нужен ручной отклик',
        archived: 'вакансия в архиве',
        disabled: 'вакансия недоступна',
        limit_exceeded: 'исчерпан лимит откликов hh',
        resume_not_found: 'резюме не найдено (проверьте hh_resume_id)',
      };
      const readable = values.map((v) => map[v] ?? v);
      if (readable.length) return `hh ${e.status}: ${readable.join('; ')}`;
      if (body.description) return `hh ${e.status}: ${body.description}`;
    } catch {
      /* сырое тело ниже */
    }
    return e.message;
  }
  return errorMessage(e);
}

/**
 * Строка очереди для режима NO_OAUTH/FALLBACK: статус остаётся `queued` до тех пор,
 * пока владелец не подтвердит отклик кнопкой. Автоотправки (POST /negotiations) нет.
 */
export function manualQueueRow(vacancyId: string, tgMessageId?: number): Record<string, unknown> {
  return {
    vacancy_id: vacancyId,
    user_id: OWNER_ID,
    status: 'queued',
    queued_at: new Date().toISOString(),
    ...(tgMessageId ? { tg_message_id: tgMessageId } : {}),
  };
}

/** Патч при подтверждении ручного отклика («✅ Я откликнулся»): sent ставится только тут. */
export function manualAppliedPatch(): Record<string, unknown> {
  return { status: 'sent', manual: true, sent_at: new Date().toISOString(), error: null };
}

export async function latestLetter(db: SupabaseClient, vacancyId: string): Promise<LetterRow | null> {
  const { data } = await db
    .from('letters')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .order('version', { ascending: false })
    .limit(1);
  return (data?.[0] as LetterRow | undefined) ?? null;
}

/**
 * Отправка одного отклика: POST /negotiations с письмом и резюме выбранной версии.
 * Все guardrails проверяются здесь ещё раз — независимо от того, кто вызвал
 * (пайплайн-autopilot, кнопка в Telegram или veto-таймаут).
 */
export async function sendApplication(deps: SendDeps, vacancyId: string): Promise<{ ok: boolean; error?: string }> {
  const { db, cfg } = deps;
  const fail = async (error: string) => {
    await db
      .from('applications')
      .upsert({ vacancy_id: vacancyId, user_id: OWNER_ID, status: 'failed', error }, { onConflict: 'vacancy_id,user_id' });
    return { ok: false, error };
  };

  const { data: vac } = await db.from('vacancies').select('*').eq('id', vacancyId).maybeSingle();
  if (!vac) return { ok: false, error: 'вакансия не найдена в БД' };
  const v = vac as VacancyRow;

  // Guardrail 3: никаких двойных откликов
  const { data: app } = await db
    .from('applications')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .maybeSingle();
  const a = app as ApplicationRow | null;
  if (a && ALREADY_SENT_STATUSES.includes(a.status)) return { ok: false, error: 'отклик уже отправлен' };

  // Guardrails 1–2: возраст и has_test
  const elig = sendEligibility(v, cfg.filters.max_vacancy_age_days);
  if (!elig.ok) return fail(elig.reason as string);

  const { data: evRow } = await db
    .from('evaluations')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .maybeSingle();
  const ev = evRow as EvaluationRow | null;
  const versionKey = ev?.resume_version ?? Object.keys(cfg.scoring.resume_versions)[0];
  const resumeId = cfg.scoring.resume_versions[versionKey]?.hh_resume_id;
  if (!resumeId) {
    return fail(`не задан hh_resume_id для версии резюме "${versionKey}" (config/settings.json; список id: npm run hh-auth)`);
  }

  const letter = await latestLetter(db, vacancyId);
  if (!letter) return fail('нет сгенерированного письма');

  const hh = deps.hh ?? (await getAuthedHH(db));
  try {
    await hh.apply(vacancyId, resumeId, letter.text);
  } catch (e) {
    return fail(hhErrorText(e));
  }
  await db
    .from('applications')
    .upsert(
      { vacancy_id: vacancyId, user_id: OWNER_ID, status: 'sent', sent_at: new Date().toISOString(), error: null },
      { onConflict: 'vacancy_id,user_id' },
    );
  return { ok: true };
}

/**
 * Veto-режим: авто-отправка откликов, по которым владелец не отреагировал
 * за veto_timeout_minutes. Вызывается из sweep-воркера и в начале каждого прогона.
 */
export async function processVetoQueue(deps: SendDeps): Promise<{ sent: number; failed: number }> {
  const { db, cfg, tg } = deps;
  const out = { sent: 0, failed: 0 };
  if (cfg.paused || cfg.sending.mode !== 'veto') return out;

  const cutoff = new Date(Date.now() - cfg.sending.veto_timeout_minutes * 60_000).toISOString();
  const { data } = await db
    .from('applications')
    .select('*')
    .eq('user_id', OWNER_ID)
    .eq('status', 'queued')
    .lt('queued_at', cutoff);
  const rows = (data ?? []) as ApplicationRow[];
  if (!rows.length) return out;

  const hh = deps.hh ?? (await getAuthedHH(db));
  const chatId = cfg.telegram.chat_id;
  for (const row of rows) {
    const res = await sendApplication({ ...deps, hh }, row.vacancy_id);
    if (res.ok) out.sent++;
    else out.failed++;
    if (tg && chatId) {
      const { data: vacRow } = await db.from('vacancies').select('title, employer').eq('id', row.vacancy_id).maybeSingle();
      const label = vacRow ? `${vacRow.title} @ ${vacRow.employer ?? '—'}` : row.vacancy_id;
      // после авто-отправки: метки 👍/👎 + «⭐ В эталоны» (отправленное = одобренное письмо)
      if (row.tg_message_id) {
        await tg
          .editButtons(chatId, row.tg_message_id, res.ok ? postSendKeyboard(row.vacancy_id) : labelKeyboard(row.vacancy_id))
          .catch(() => undefined);
      }
      await tg
        .sendMessage(
          chatId,
          res.ok ? `✅ Отправлено (veto-таймаут): ${label}` : `❌ Не отправлено: ${label} — ${res.error}`,
          undefined,
          row.tg_message_id ?? undefined,
        )
        .catch(() => undefined);
    }
  }
  return out;
}
