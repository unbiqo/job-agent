import 'dotenv/config';
import { getTelegram } from '../src/lib/telegram';

/** Привязка webhook: npm run tg-webhook -- https://<app>.vercel.app */
async function main() {
  const base = process.argv[2];
  if (!base) {
    console.log('Использование: npm run tg-webhook -- https://<app>.vercel.app');
    process.exit(1);
  }
  const tg = getTelegram();
  if (!tg) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  const url = base.replace(/\/+$/, '') + '/api/telegram';
  await tg.setWebhook(url, process.env.TELEGRAM_WEBHOOK_SECRET);
  console.log('✅ Webhook установлен: ' + url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
