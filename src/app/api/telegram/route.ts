import { handleTelegramUpdate } from '@/lib/bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// /add в FALLBACK-режиме делает инлайн-скоринг и письмо (LLM) — даём больше времени
export const maxDuration = 60;

/** Telegram webhook (кнопки карточек и команды бота). */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const update = await req.json();
    await handleTelegramUpdate(update);
  } catch (e) {
    // Telegram ретраит не-200; логируем и отвечаем ok, чтобы не зациклить повтор
    console.error('telegram webhook:', e);
  }
  return Response.json({ ok: true });
}
