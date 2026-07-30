import 'dotenv/config';
import { getTelegram } from '../src/lib/telegram';

async function main() {
  const base = process.argv[2];
  if (!base) {
    console.log('Usage: npm run tg-webhook -- https://<app>.vercel.app');
    process.exit(1);
  }

  const tg = getTelegram();
  if (!tg) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const url = base.replace(/\/+$/, '') + '/api/telegram';
  await tg.setWebhook(url, process.env.TELEGRAM_WEBHOOK_SECRET?.trim());
  console.log('Webhook installed: ' + url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
