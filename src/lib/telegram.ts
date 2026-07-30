import type { EvaluationRow, SalaryJson, VacancyRow } from './types';
import { truncate, vacancyAgeDays } from './util';

export interface TgButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TgInlineKeyboard {
  inline_keyboard: TgButton[][];
}

export class Telegram {
  constructor(private token: string) {}

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: boolean; description?: string; result?: T };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  }

  sendMessage(chatId: string | number, text: string, keyboard?: TgInlineKeyboard, replyTo?: number) {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: truncate(text, 4096),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  clearButtons(chatId: string | number, messageId: number) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
  }

  editButtons(chatId: string | number, messageId: number, keyboard: TgInlineKeyboard) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
  }

  answerCallback(callbackQueryId: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  setWebhook(url: string, secret?: string) {
    return this.call('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      ...(secret ? { secret_token: secret } : {}),
    });
  }
}

export function getTelegram(): Telegram | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? new Telegram(token) : null;
}

const CURRENCY: Record<string, string> = { RUR: '₽', RUB: '₽', KZT: '₸', USD: '$', EUR: '€', BYR: 'Br' };

export function formatSalary(s?: SalaryJson | null): string {
  if (!s || (s.from == null && s.to == null)) return 'з/п не указана';
  const cur = CURRENCY[s.currency ?? ''] ?? (s.currency ?? '');
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}к` : String(n));
  if (s.from != null && s.to != null) return `${k(s.from)}-${k(s.to)} ${cur}`;
  if (s.from != null) return `от ${k(s.from)} ${cur}`;
  return `до ${k(s.to as number)} ${cur}`;
}

export function publishedLabel(publishedAt: string | null, now = new Date()): string {
  if (!publishedAt) return '';
  const days = Math.floor(vacancyAgeDays(publishedAt, now));
  if (days <= 0) return 'опубликована сегодня';
  if (days === 1) return 'опубликована вчера';
  return `опубликована ${days} дн. назад`;
}

function scheduleLabel(v: VacancyRow): string {
  const raw = v.raw as { schedule?: { id?: string; name?: string } } | null;
  if (raw?.schedule?.id === 'remote') return 'удалённо';
  return raw?.schedule?.name ?? '';
}

export function formatCard(
  v: VacancyRow,
  ev: Pick<EvaluationRow, 'score' | 'reasons' | 'red_flags'> | null,
  letterText: string | null,
  resumeTitle: string,
): string {
  const score = ev?.score ?? 0;
  const marker = score >= 8 ? '🔥' : score >= 7 ? '✨' : '📋';
  const reasons = (ev?.reasons ?? []).join('; ');
  const flags = (ev?.red_flags ?? []).join('; ');
  const parts = [
    `${marker} ${score}/10 · ${v.title} @ ${v.employer ?? '-'}`,
    [formatSalary(v.salary), scheduleLabel(v), publishedLabel(v.published_at)].filter(Boolean).join(' · '),
    reasons ? `Почему подходит: ${reasons}` : '',
    flags ? `Риски: ${flags}` : '',
    `Резюме: ${resumeTitle}`,
    `https://hh.ru/vacancy/${v.id}`,
    '---',
    letterText ? truncate(letterText, 2500) : '(письма нет)',
  ];
  return parts.filter(Boolean).join('\n');
}

export function labelRow(vacancyId: string): TgButton[] {
  return [
    { text: '👍 релевантно', callback_data: `like:${vacancyId}` },
    { text: '👎 мимо', callback_data: `dislike:${vacancyId}` },
  ];
}

export function labelKeyboard(vacancyId: string): TgInlineKeyboard {
  return { inline_keyboard: [labelRow(vacancyId)] };
}

export function postSendKeyboard(vacancyId: string): TgInlineKeyboard {
  return {
    inline_keyboard: [labelRow(vacancyId), [{ text: '⭐ В эталоны', callback_data: `star:${vacancyId}` }]],
  };
}

export function vetoKeyboard(vacancyId: string): TgInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Отправить', callback_data: `send:${vacancyId}` },
        { text: '✏️ Править', callback_data: `edit:${vacancyId}` },
        { text: '⏭ Пропустить', callback_data: `skip:${vacancyId}` },
      ],
      labelRow(vacancyId),
    ],
  };
}

export function manualKeyboard(vacancyId: string): TgInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '📋 Скопировать письмо', callback_data: `copy:${vacancyId}` },
        { text: '🔗 Открыть вакансию', url: `https://hh.ru/vacancy/${vacancyId}` },
      ],
      [
        { text: '✅ Я откликнулся', callback_data: `mark:${vacancyId}` },
        { text: '⏭ Пропустить', callback_data: `skip:${vacancyId}` },
      ],
      labelRow(vacancyId),
    ],
  };
}

export function statusPollKeyboard(vacancyId: string): TgInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '👀 Просмотрели', callback_data: `st_viewed:${vacancyId}` },
        { text: '📞 Пригласили', callback_data: `st_invited:${vacancyId}` },
      ],
      [
        { text: '❌ Отказ', callback_data: `st_rejected:${vacancyId}` },
        { text: '🤐 Тишина', callback_data: `st_silence:${vacancyId}` },
      ],
    ],
  };
}
