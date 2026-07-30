import 'dotenv/config';
import { runScrapeDigest } from '../src/lib/scrape-digest';

// --dry-run: без отправки в Telegram и без записи applications — список печатается в stdout
const dryRun = process.argv.includes('--dry-run');

runScrapeDigest({ dryRun }).catch((e) => {
  console.error(e);
  process.exit(1);
});
