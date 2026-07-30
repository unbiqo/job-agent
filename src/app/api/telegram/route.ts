import { handleTelegramUpdate } from '@/lib/bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const headerSecret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret && headerSecret !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  try {
    const update = await req.json();
    await handleTelegramUpdate(update);
  } catch (e) {
    console.error('telegram webhook:', e);
  }

  return Response.json({ ok: true });
}
