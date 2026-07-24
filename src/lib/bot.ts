import type { SupabaseClient } from '@supabase/supabase-js';
import { latestLetter, manualAppliedPatch, sendApplication } from './apply';
import { loadRuntimeConfig, setConfigOverride, type RuntimeConfig } from './config';
import { getDb, OWNER_ID } from './db';
import { countRevisionRounds, loadStyleExamples, logLetterFeedback, saveCuratedExample } from './curated';
import { editModeForRounds } from './feedback';
import { HHClient, hhUserAgent } from './hh';
import { saveLetterEvent, saveVacancyLabel } from './labels';
import { generateLetter, reviseLetter } from './letters';
import { createLLM } from './llm/client';
import { loadProfileSmart } from './profile';
import { createScorer } from './scorer';
import {
  formatCard,
  getTelegram,
  labelKeyboard,
  manualKeyboard,
  postSendKeyboard,
  vetoKeyboard,
  type Telegram,
} from './telegram';
import { formatViolations } from './validate-letter';
import type { ApplicationRow, EvaluationRow, RunStats, VacancyRow } from './types';
import { errorMessage, stripHtml } from './util';
import { FALLBACK_FLAG, manualVacancyId, parseVacancyInput, withFallbackFlag } from './vacancy-add';

const HELP = [
  'Команды:',
  '/digest — сводка последнего прогона',
  '/queue — очередь на отправку',
  '/stats — метрики и конверсия',
  '/add <ссылка hh или текст> — добавить вакансию вручную (fallback)',
  '/pause и /resume — пауза/продолжение',
  '/mode review|veto|autopilot — режим отправки',
].join('\n');

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
    await handleCallback(db, cfg, tg, cq as Required<Pick<TgUpdate, 'callback_query'>>['callback_query']);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;
  if (!ownerChat) {
    // онбординг: подсказываем chat_id
    await tg
      .sendMessage(
        msg.chat.id,
        `Ваш chat_id: ${msg.chat.id}\nУкажите его в config/settings.json → telegram.chat_id (или env TELEGRAM_CHAT_ID) и передеплойте.`,
      )
      .catch(() => undefined);
    return;
  }
  if (String(msg.chat.id) !== String(ownerChat)) return; // чужих игнорируем
  await handleMessage(db, cfg, tg, msg.text.trim());
}

async function vacancyLabel(db: SupabaseClient, vacancyId: string): Promise<string> {
  const { data } = await db.from('vacancies').select('title, employer').eq('id', vacancyId).maybeSingle();
  return data ? `${data.title} @ ${data.employer ?? '—'}` : vacancyId;
}

async function handleCallback(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  tg: Telegram,
  cq: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } },
): Promise<void> {
  const [action, vacancyId] = (cq.data ?? '').split(':');
  const chatId = cq.message?.chat.id as number;
  const messageId = cq.message?.message_id as number;
  if (!vacancyId) {
    await tg.answerCallback(cq.id).catch(() => undefined);
    return;
  }
  const label = await vacancyLabel(db, vacancyId);
  try {
    if (action === 'send') {
      const res = await sendApplication({ db, cfg, tg }, vacancyId);
      if (res.ok) await saveLetterEvent(db, vacancyId, 'letter_ok').catch(() => undefined);
      await tg.answerCallback(cq.id, res.ok ? 'Отправлено ✅' : 'Ошибка').catch(() => undefined);
      // после отправки: метки 👍/👎 + «⭐ В эталоны» для финального письма (задача 9)
      await tg
        .editButtons(chatId, messageId, res.ok ? postSendKeyboard(vacancyId) : labelKeyboard(vacancyId))
        .catch(() => undefined);
      await tg.sendMessage(
        chatId,
        res.ok ? `✅ Отправлено: ${label}` : `❌ Не отправлено: ${label} — ${res.error}`,
        undefined,
        messageId,
      );
    } else if (action === 'skip') {
      await db
        .from('applications')
        .upsert(
          { vacancy_id: vacancyId, user_id: OWNER_ID, status: 'vetoed', error: null },
          { onConflict: 'vacancy_id,user_id' },
        );
      await tg.answerCallback(cq.id, 'Пропущено').catch(() => undefined);
      await tg.editButtons(chatId, messageId, labelKeyboard(vacancyId)).catch(() => undefined);
      await tg.sendMessage(chatId, `⏭ Пропущено: ${label}`, undefined, messageId);
    } else if (action === 'like' || action === 'dislike') {
      // Задача 2 слоя качества: метка релевантности → таблица labels (+ снапшот скора)
      await saveVacancyLabel(db, vacancyId, action === 'like' ? 'relevant' : 'irrelevant');
      await tg
        .answerCallback(cq.id, action === 'like' ? 'Записано: релевантно 👍' : 'Записано: мимо 👎')
        .catch(() => undefined);
    } else if (action === 'edit') {
      // Задача 8: правка через LLM (максимум N раундов), дальше needs_manual — только готовый текст
      const maxRounds = cfg.letters.max_revision_rounds ?? 3;
      const rounds = await countRevisionRounds(db, vacancyId);
      const mode = editModeForRounds(rounds, maxRounds);
      await db
        .from('users')
        .update({ bot_state: { awaiting_edit: vacancyId, card_message_id: messageId, edit_mode: mode } })
        .eq('id', OWNER_ID);
      await tg.answerCallback(cq.id).catch(() => undefined);
      await tg.sendMessage(
        chatId,
        mode === 'revise'
          ? `✏️ Что поправить в письме для: ${label}?\nОтветьте свободным текстом (раунд ${rounds + 1}/${maxRounds}) — изменю только указанное.`
          : `✋ Лимит LLM-правок (${maxRounds}) исчерпан — needs_manual.\nПришлите готовый текст письма целиком, сохраню как есть: ${label}`,
      );
    } else if (action === 'copy') {
      // NO_OAUTH: прислать текст письма отдельным сообщением для ручного отклика
      const letter = await latestLetter(db, vacancyId);
      await tg.answerCallback(cq.id, letter ? 'Письмо ниже' : 'Письма нет').catch(() => undefined);
      if (letter) await tg.sendMessage(chatId, letter.text);
    } else if (action === 'mark') {
      // «✅ Я откликнулся» — sent ставится ТОЛЬКО здесь, с пометкой manual
      await db
        .from('applications')
        .upsert({ vacancy_id: vacancyId, user_id: OWNER_ID, ...manualAppliedPatch() }, { onConflict: 'vacancy_id,user_id' });
      await saveLetterEvent(db, vacancyId, 'letter_ok').catch(() => undefined);
      await tg.answerCallback(cq.id, 'Отмечено ✅').catch(() => undefined);
      await tg.editButtons(chatId, messageId, postSendKeyboard(vacancyId)).catch(() => undefined);
      await tg.sendMessage(chatId, `✅ Отмечено как отправленное вручную: ${label}`, undefined, messageId);
    } else if (action === 'star') {
      // Задача 9: финальное одобренное письмо → пул эталонов стиля
      const res = await saveCuratedExample(db, vacancyId);
      await tg
        .answerCallback(cq.id, res.ok ? `В эталонах ⭐ (всего ${res.total})` : `Не вышло: ${res.error}`)
        .catch(() => undefined);
      if (res.ok && res.total === 3 && !cfg.letters.use_style_examples) {
        await tg.sendMessage(
          chatId,
          '⭐ В пуле 3 эталона — можно включить few-shot стиля: config/settings.json → letters.use_style_examples: true',
        );
      }
    } else if (action === 'st_viewed' || action === 'st_invited' || action === 'st_rejected' || action === 'st_silence') {
      await handleStatusPoll(db, tg, chatId, messageId, action, vacancyId, label, cq.id);
    } else {
      await tg.answerCallback(cq.id).catch(() => undefined);
    }
  } catch (e) {
    await tg.answerCallback(cq.id, 'Ошибка').catch(() => undefined);
    await tg.sendMessage(chatId, `⚠️ ${errorMessage(e)}`).catch(() => undefined);
  }
}

const POLL_STATUS: Record<string, 'viewed' | 'invited' | 'rejected' | null> = {
  st_viewed: 'viewed',
  st_invited: 'invited',
  st_rejected: 'rejected',
  st_silence: null,
};

/** Ответ на 3-дневный опрос статуса ручного отклика (спека 3.7). */
async function handleStatusPoll(
  db: SupabaseClient,
  tg: Telegram,
  chatId: number,
  messageId: number,
  action: string,
  vacancyId: string,
  label: string,
  callbackId: string,
): Promise<void> {
  const status = POLL_STATUS[action];
  const patch: Record<string, unknown> = { polled_at: new Date().toISOString() };
  if (status) {
    patch.status = status;
    if (status === 'invited' || status === 'rejected') patch.response_at = new Date().toISOString();
  }
  await db.from('applications').update(patch).eq('vacancy_id', vacancyId).eq('user_id', OWNER_ID);
  await tg.answerCallback(callbackId, 'Записано').catch(() => undefined);
  await tg.clearButtons(chatId, messageId).catch(() => undefined);
  const human = status
    ? { viewed: 'просмотрели', invited: 'пригласили 🎉', rejected: 'отказ' }[status]
    : 'без изменений';
  await tg.sendMessage(chatId, `📊 ${label}: ${human}`, undefined, messageId);
}

async function handleMessage(db: SupabaseClient, cfg: RuntimeConfig, tg: Telegram, text: string): Promise<void> {
  const chatId = cfg.telegram.chat_id;

  // Режим «✏️ Править» (задача 8): текст владельца — это ЗАМЕЧАНИЕ, LLM правит письмо
  // (edit_mode='revise'); после исчерпания раундов — готовый текст целиком ('manual').
  const { data: userRow } = await db.from('users').select('bot_state').eq('id', OWNER_ID).maybeSingle();
  const st = (userRow?.bot_state ?? {}) as {
    awaiting_edit?: string;
    card_message_id?: number;
    edit_mode?: 'revise' | 'manual';
  };
  if (st.awaiting_edit && !text.startsWith('/')) {
    const vacancyId = st.awaiting_edit;
    const prev = await latestLetter(db, vacancyId);
    const mode = prev ? (st.edit_mode ?? 'revise') : 'manual';
    await db.from('users').update({ bot_state: {} }).eq('id', OWNER_ID);
    if (st.card_message_id) {
      await tg.editButtons(chatId, st.card_message_id, labelKeyboard(vacancyId)).catch(() => undefined);
    }

    const { data: vac } = await db.from('vacancies').select('*').eq('id', vacancyId).maybeSingle();
    const { data: evRow } = await db
      .from('evaluations')
      .select('*')
      .eq('vacancy_id', vacancyId)
      .eq('user_id', OWNER_ID)
      .maybeSingle();
    const v = vac as VacancyRow | null;
    const ev = evRow as EvaluationRow | null;
    const resumeTitle = cfg.scoring.resume_versions[ev?.resume_version ?? '']?.title ?? '—';

    let newText = text;
    let header: string;
    const version = (prev?.version ?? 0) + 1;
    if (mode === 'revise' && prev && v) {
      await tg.sendMessage(chatId, '✍️ Правлю письмо…').catch(() => undefined);
      try {
        const profile = await loadProfileSmart(db, cfg);
        const res = await reviseLetter(
          createLLM(cfg, 'letters'),
          cfg,
          profile,
          v,
          ev?.resume_version ?? null,
          prev.text,
          text,
        );
        newText = res.text;
        await db.from('letters').insert({
          vacancy_id: vacancyId,
          user_id: OWNER_ID,
          text: newText,
          version,
          needs_review: res.needsReview,
        });
        await logLetterFeedback(db, {
          vacancy_id: vacancyId,
          letter_version: prev.version,
          feedback_text: text,
          original_text: prev.text,
          revised_text: newText,
          status: res.needsReview ? 'validation_failed' : 'revised',
        });
        header = res.needsReview
          ? `⚠️ Правка применена, но письмо не прошло валидатор (v${version}): ${formatViolations(res.violations)}\nОно не уйдёт без вашего решения.`
          : `✏️ Письмо обновлено (v${version}).`;
      } catch (e) {
        await tg.sendMessage(chatId, `⚠️ Не удалось поправить письмо: ${errorMessage(e)}`).catch(() => undefined);
        return;
      }
    } else {
      // manual: готовый текст владельца сохраняется как есть (проверено человеком)
      await db.from('letters').insert({ vacancy_id: vacancyId, user_id: OWNER_ID, text, version, needs_review: false });
      await logLetterFeedback(db, {
        vacancy_id: vacancyId,
        letter_version: prev?.version ?? null,
        feedback_text: '(ручная замена целиком)',
        original_text: prev?.text ?? '',
        revised_text: text,
        status: 'manual',
      });
      header = `✏️ Письмо заменено вручную (v${version}).`;
    }
    await saveLetterEvent(db, vacancyId, 'letter_edited').catch(() => undefined);

    const card = v ? formatCard(v, ev, newText, resumeTitle) : newText;
    const msg = await tg.sendMessage(chatId, header + '\n\n' + card, vetoKeyboard(vacancyId));
    // перезапускаем veto-таймер с новым письмом и новой карточкой
    await db
      .from('applications')
      .update({ tg_message_id: msg.message_id, queued_at: new Date().toISOString() })
      .eq('vacancy_id', vacancyId)
      .eq('user_id', OWNER_ID)
      .eq('status', 'queued');
    return;
  }

  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd) {
    case '/start':
    case '/help':
      await tg.sendMessage(chatId, 'JobAgent — AI-агент автопоиска работы на hh.\n' + HELP);
      break;
    case '/digest':
      await cmdDigest(db, tg, chatId);
      break;
    case '/queue':
      await cmdQueue(db, tg, chatId);
      break;
    case '/stats':
      await cmdStats(db, tg, chatId);
      break;
    case '/add':
      await cmdAdd(db, cfg, tg, chatId, args.join(' '));
      break;
    case '/pause':
      await setConfigOverride(db, { paused: true });
      await tg.sendMessage(chatId, '⏸ Агент на паузе: скоринг и отправка остановлены. /resume — продолжить.');
      break;
    case '/resume':
      await setConfigOverride(db, { paused: false });
      await tg.sendMessage(chatId, '▶️ Агент снова работает.');
      break;
    case '/mode': {
      const m = args[0];
      if (m === 'review' || m === 'veto' || m === 'autopilot') {
        await setConfigOverride(db, { send_mode: m });
        await tg.sendMessage(chatId, `Режим отправки: ${m}`);
      } else {
        await tg.sendMessage(chatId, `Сейчас: ${cfg.sending.mode}${cfg.paused ? ' (пауза)' : ''}\nИспользование: /mode review|veto|autopilot`);
      }
      break;
    }
    default:
      await tg.sendMessage(chatId, 'Не понял команду.\n' + HELP);
  }
}

async function cmdDigest(db: SupabaseClient, tg: Telegram, chatId: string): Promise<void> {
  const { data } = await db
    .from('runs')
    .select('*')
    .eq('user_id', OWNER_ID)
    .order('started_at', { ascending: false })
    .limit(1);
  const run = data?.[0];
  if (!run) {
    await tg.sendMessage(chatId, 'Прогонов ещё не было.');
    return;
  }
  const s = (run.stats ?? {}) as Partial<RunStats>;
  const started = new Date(run.started_at as string).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const { count: queued } = await db
    .from('applications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .eq('status', 'queued');
  await tg.sendMessage(
    chatId,
    [
      `📊 Последний прогон: ${started}${run.finished_at ? '' : ' (ещё выполняется)'}`,
      `Собрано ${s.collected ?? 0} (новых ${s.new ?? 0}) · префильтр −${s.excluded ?? 0} · оценено ${s.scored ?? 0}, выше порога ${s.above_threshold ?? 0}`,
      `Письма: ${s.lettered ?? 0} · отправлено ${s.sent ?? 0} · в очереди сейчас ${queued ?? 0} · ошибок ${s.failed ?? 0}`,
      `💰 ${run.tokens_in ?? 0} in / ${run.tokens_out ?? 0} out токенов · $${Number(run.cost_usd ?? 0).toFixed(4)}`,
      ...(Array.isArray(s.errors) && s.errors.length ? [`⚠️ ${s.errors.slice(0, 3).join('\n⚠️ ')}`] : []),
    ].join('\n'),
  );
}

async function cmdQueue(db: SupabaseClient, tg: Telegram, chatId: string): Promise<void> {
  const { data } = await db
    .from('applications')
    .select('vacancy_id, queued_at')
    .eq('user_id', OWNER_ID)
    .eq('status', 'queued')
    .order('queued_at', { ascending: true });
  const rows = (data ?? []) as { vacancy_id: string; queued_at: string | null }[];
  if (!rows.length) {
    await tg.sendMessage(chatId, 'Очередь пуста.');
    return;
  }
  const lines: string[] = [`⏳ В очереди ${rows.length}:`];
  for (const r of rows.slice(0, 15)) {
    const { data: ev } = await db
      .from('evaluations')
      .select('score')
      .eq('vacancy_id', r.vacancy_id)
      .eq('user_id', OWNER_ID)
      .maybeSingle();
    const label = await vacancyLabel(db, r.vacancy_id);
    const mins = r.queued_at ? Math.floor((Date.now() - Date.parse(r.queued_at)) / 60_000) : 0;
    lines.push(`• ${ev?.score ?? '—'}/10 · ${label} · ждёт ${mins} мин`);
  }
  await tg.sendMessage(chatId, lines.join('\n'));
}

async function cmdStats(db: SupabaseClient, tg: Telegram, chatId: string): Promise<void> {
  const { data: appsData } = await db.from('applications').select('status').eq('user_id', OWNER_ID);
  const counts: Record<string, number> = {};
  for (const a of (appsData ?? []) as Pick<ApplicationRow, 'status'>[]) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }
  const sentTotal =
    (counts.sent ?? 0) + (counts.viewed ?? 0) + (counts.invited ?? 0) + (counts.rejected ?? 0) + (counts.offer ?? 0);
  const answered = (counts.invited ?? 0) + (counts.rejected ?? 0) + (counts.offer ?? 0);
  const { count: vacTotal } = await db.from('vacancies').select('*', { count: 'exact', head: true });

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: runRows } = await db
    .from('runs')
    .select('cost_usd, tokens_in, tokens_out')
    .eq('user_id', OWNER_ID)
    .gte('started_at', monthStart.toISOString());
  const cost = ((runRows ?? []) as { cost_usd: number }[]).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
  await tg.sendMessage(
    chatId,
    [
      '📈 Метрики JobAgent',
      `Вакансий в базе: ${vacTotal ?? 0}`,
      `Отправлено всего: ${sentTotal} · просмотрено: ${counts.viewed ?? 0} · приглашений: ${counts.invited ?? 0} · отказов: ${counts.rejected ?? 0}`,
      `В очереди: ${counts.queued ?? 0} · пропущено: ${counts.vetoed ?? 0} · ошибок: ${counts.failed ?? 0}`,
      `Конверсия отклик→ответ: ${pct(answered, sentTotal)} · отклик→приглашение: ${pct(counts.invited ?? 0, sentTotal)}`,
      `💰 Стоимость за месяц: $${cost.toFixed(4)}`,
    ].join('\n'),
  );
}

/**
 * /add — FALLBACK-минимум (спека 3.3, Задача 3): ручное добавление вакансии по
 * ссылке hh (через API, без парсинга HTML) или свободным текстом. Далее обычный
 * скоринг и письмо; в red_flags — пометка «данные неполные: fallback-источник».
 */
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
      // hh недоступен по API — оставляем синтетическую строку с пометкой fallback
    }
  }
  await db.from('vacancies').upsert(row, { onConflict: 'id' });
  await tg.sendMessage(chatId, '✅ Добавлено, оцениваю…');

  const { data: vac } = await db.from('vacancies').select('*').eq('id', vacId).maybeSingle();
  const v = vac as VacancyRow;
  const profile = await loadProfileSmart(db, cfg);
  const versions = Object.keys(cfg.scoring.resume_versions);

  let ev = {
    score: cfg.scoring.threshold,
    verdict: 'partial' as string,
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

  let letterText: string | null = null;
  let reviewNote = '';
  try {
    const styleExamples = await loadStyleExamples(db, cfg).catch(() => [] as string[]);
    const r = await generateLetter(createLLM(cfg, 'letters'), cfg, profile, v, ev, styleExamples);
    letterText = r.text;
    await db.from('letters').upsert(
      { vacancy_id: vacId, user_id: OWNER_ID, text: r.text, version: 1, needs_review: r.needsReview },
      { onConflict: 'vacancy_id,user_id,version' },
    );
    if (r.needsReview) {
      reviewNote = `⚠️ Письмо требует ручной проверки: ${formatViolations(r.violations)}\n\n`;
    }
  } catch {
    // письмо не сгенерировалось — покажем карточку без письма
  }

  const resumeTitle = cfg.scoring.resume_versions[ev.resume_version]?.title ?? '—';
  await tg.sendMessage(chatId, reviewNote + formatCard(v, ev, letterText, resumeTitle), manualKeyboard(vacId));
}
