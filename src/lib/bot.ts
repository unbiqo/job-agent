import type { SupabaseClient } from '@supabase/supabase-js';
import { loadRuntimeConfig, type RuntimeConfig } from './config';
import { getDb, OWNER_ID } from './db';
import { HHClient, hhUserAgent } from './hh';
import { saveVacancyLabel } from './labels';
import { loadProfileSmart } from './profile';
import { createScorer } from './scorer';
import { getTelegram, type Telegram } from './telegram';
import type { VacancyRow } from './types';
import { errorMessage, stripHtml } from './util';
import { FALLBACK_FLAG, manualVacancyId, parseVacancyInput, withFallbackFlag } from './vacancy-add';

const HELP = [
  'JobAgent присылает в Telegram только уведомления.',
  'Вакансии, описания и письма открываются в web inbox.',
  '/digest - последний прогон',
  '/add <hh link или текст> - вручную добавить вакансию в inbox',
].join('\n');

function appUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  if (prod) return (prod.startsWith('http') ? prod : `https://${prod}`).replace(/\/+$/, '');
  return '';
}

interface TgUpdate {
  message?: { message_id: number; text?: string; chat: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  const tg = getTelegram();
  if (!tg) return;

  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const ownerChat = cfg.telegram.chat_id;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    if (!ownerChat || String(chatId) !== String(ownerChat)) {
      await tg.answerCallback(cq.id).catch(() => undefined);
      return;
    }
    await handleCallback(db, tg, cq as Required<Pick<TgUpdate, 'callback_query'>>['callback_query']);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  if (!ownerChat) {
    await tg
      .sendMessage(
        msg.chat.id,
        `Ваш chat_id: ${msg.chat.id}\nУкажите его в config/settings.json -> telegram.chat_id или env TELEGRAM_CHAT_ID.`,
      )
      .catch(() => undefined);
    return;
  }

  if (String(msg.chat.id) !== String(ownerChat)) return;
  await handleMessage(db, cfg, tg, msg.text.trim());
}

async function vacancyLabel(db: SupabaseClient, vacancyId: string): Promise<string> {
  const { data } = await db.from('vacancies').select('title, employer').eq('id', vacancyId).maybeSingle();
  return data ? `${data.title} @ ${data.employer ?? '-'}` : vacancyId;
}

async function sendInboxLink(tg: Telegram, chatId: string | number, replyTo?: number): Promise<void> {
  const inbox = appUrl();
  await tg.sendMessage(
    chatId,
    inbox
      ? `Откройте inbox:\n${inbox}`
      : 'PUBLIC_BASE_URL не настроен. Откройте web inbox на текущем деплое приложения.',
    inbox ? { inline_keyboard: [[{ text: 'Открыть inbox', url: inbox }]] } : undefined,
    replyTo,
  );
}

async function handleCallback(
  db: SupabaseClient,
  tg: Telegram,
  cq: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } },
): Promise<void> {
  const [action, vacancyId] = (cq.data ?? '').split(':');
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !vacancyId) {
    await tg.answerCallback(cq.id).catch(() => undefined);
    return;
  }

  try {
    if (action === 'skip') {
      await db
        .from('applications')
        .upsert(
          { vacancy_id: vacancyId, user_id: OWNER_ID, status: 'vetoed', error: null },
          { onConflict: 'vacancy_id,user_id' },
        );
      await tg.answerCallback(cq.id, 'Пропущено').catch(() => undefined);
      await tg.sendMessage(chatId, `Пропущено: ${await vacancyLabel(db, vacancyId)}`, undefined, messageId);
      return;
    }

    if (action === 'like' || action === 'dislike') {
      await saveVacancyLabel(db, vacancyId, action === 'like' ? 'relevant' : 'irrelevant');
      await tg.answerCallback(cq.id, action === 'like' ? 'Записано: релевантно' : 'Записано: мимо').catch(() => undefined);
      return;
    }

    await tg.answerCallback(cq.id, 'Теперь это делается в inbox').catch(() => undefined);
    await sendInboxLink(tg, chatId, messageId);
  } catch (e) {
    await tg.answerCallback(cq.id, 'Ошибка').catch(() => undefined);
    await tg.sendMessage(chatId, `Ошибка: ${errorMessage(e)}`).catch(() => undefined);
  }
}

async function handleMessage(db: SupabaseClient, cfg: RuntimeConfig, tg: Telegram, text: string): Promise<void> {
  const chatId = cfg.telegram.chat_id;
  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd) {
    case '/start':
    case '/help':
      await tg.sendMessage(chatId, ['JobAgent', HELP, appUrl() ? `Inbox: ${appUrl()}` : ''].filter(Boolean).join('\n'));
      break;
    case '/digest':
      await cmdDigest(db, tg, chatId);
      break;
    case '/add':
      await cmdAdd(db, cfg, tg, chatId, args.join(' '));
      break;
    case '/letter':
      await sendInboxLink(tg, chatId);
      break;
    default:
      await tg.sendMessage(chatId, `Не понял команду.\n${HELP}`);
  }
}

async function cmdDigest(db: SupabaseClient, tg: Telegram, chatId: string): Promise<void> {
  const { data } = await db
    .from('runs')
    .select('started_at, finished_at, stats, tokens_in, tokens_out, cost_usd')
    .eq('user_id', OWNER_ID)
    .order('started_at', { ascending: false })
    .limit(1);
  const run = data?.[0];
  if (!run) {
    await tg.sendMessage(chatId, 'Прогонов ещё не было.');
    return;
  }

  const s = (run.stats ?? {}) as Partial<{
    collected: number;
    new: number;
    excluded: number;
    scored: number;
    above_threshold: number;
    queued: number;
    failed: number;
    errors: string[];
  }>;
  const started = new Date(run.started_at as string).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  await tg.sendMessage(
    chatId,
    [
      `Последний прогон: ${started}${run.finished_at ? '' : ' (ещё выполняется)'}`,
      `Собрано: ${s.collected ?? 0}, новых: ${s.new ?? 0}, оценено: ${s.scored ?? 0}, релевантных: ${s.above_threshold ?? 0}`,
      `Добавлено в inbox: ${s.queued ?? 0}, ошибок: ${s.failed ?? 0}`,
      `LLM: ${run.tokens_in ?? 0} in / ${run.tokens_out ?? 0} out, $${Number(run.cost_usd ?? 0).toFixed(4)}`,
      appUrl() ? `Inbox: ${appUrl()}` : '',
      ...(Array.isArray(s.errors) && s.errors.length ? [`Ошибки: ${s.errors.slice(0, 3).join('; ')}`] : []),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function cmdAdd(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  tg: Telegram,
  chatId: string,
  input: string,
): Promise<void> {
  if (!input.trim()) {
    await tg.sendMessage(chatId, 'Использование: /add <ссылка на вакансию hh или текст вакансии>');
    return;
  }

  const parsed = parseVacancyInput(input);
  const vacId = parsed.hhId ?? manualVacancyId();
  let row: Record<string, unknown> = {
    id: vacId,
    user_id: OWNER_ID,
    title: parsed.hhId ? `Вакансия ${vacId}` : 'Ручная вакансия',
    employer: null,
    description: parsed.text,
    published_at: new Date().toISOString(),
    has_test: false,
    raw: { source: 'fallback' },
  };

  if (parsed.hhId) {
    try {
      const d = await new HHClient({ userAgent: hhUserAgent() }).getVacancy(parsed.hhId);
      row = {
        id: parsed.hhId,
        user_id: OWNER_ID,
        title: d.name,
        employer: d.employer?.name ?? null,
        salary: d.salary ?? null,
        area: d.area?.name ?? null,
        published_at: d.published_at ?? new Date().toISOString(),
        description: d.description ? stripHtml(d.description) : parsed.text,
        key_skills: (d.key_skills ?? []).map((k) => k.name),
        has_test: d.has_test ?? false,
        raw: { ...d, source: 'fallback' },
      };
    } catch {
      // If hh API is unavailable, keep the fallback row and let the inbox show what we have.
    }
  }

  await db.from('vacancies').upsert(row, { onConflict: 'id' });
  await tg.sendMessage(chatId, 'Добавлено, оцениваю...');

  const { data: vac } = await db.from('vacancies').select('*').eq('id', vacId).maybeSingle();
  const v = vac as VacancyRow;
  const profile = await loadProfileSmart(db, cfg);
  const versions = Object.keys(cfg.scoring.resume_versions);

  let ev = {
    score: cfg.scoring.threshold,
    verdict: 'partial',
    reasons: [] as string[],
    red_flags: [FALLBACK_FLAG] as string[],
    resume_version: versions[0],
    letter_hook: '',
  };
  try {
    const scored = await createScorer(cfg, profile).score(v);
    ev = { ...scored.result, red_flags: withFallbackFlag(scored.result.red_flags) };
  } catch (e) {
    ev.reasons = [`скоринг не выполнен: ${errorMessage(e)}`];
  }

  await db.from('evaluations').upsert(
    {
      vacancy_id: vacId,
      user_id: OWNER_ID,
      prefilter: 'passed',
      score: ev.score,
      verdict: ev.verdict,
      reasons: ev.reasons,
      red_flags: ev.red_flags,
      resume_version: ev.resume_version,
      letter_hook: ev.letter_hook,
    },
    { onConflict: 'vacancy_id,user_id' },
  );
  await db.from('applications').upsert(
    { vacancy_id: vacId, user_id: OWNER_ID, status: 'listed', manual: true, error: null },
    { onConflict: 'vacancy_id,user_id' },
  );

  await sendInboxLink(tg, chatId);
}
