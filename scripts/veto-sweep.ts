import 'dotenv/config';
import { processVetoQueue } from '../src/lib/apply';
import { loadRuntimeConfig } from '../src/lib/config';
import { getDb, OWNER_ID } from '../src/lib/db';
import { runDeltaPoll, runStatusPoll } from '../src/lib/delta';
import { getTelegram } from '../src/lib/telegram';
import { errorMessage } from '../src/lib/util';

/**
 * Лёгкий воркер (cron каждые 30 минут):
 *  1) дельта-поллинг (v1.2) — частый добор свежих вакансий в окне активности;
 *  2) 3-дневный опрос статуса ручных откликов (v1.1);
 *  3) авто-отправка veto-очереди по таймауту (v0).
 */
async function main() {
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);

  // Шаг 1: дельта-поллинг (сам решает, запускаться ли — по настройкам, окну, интервалу)
  await runDeltaPoll().catch((e) => console.error('delta:', errorMessage(e)));

  // Шаг 2: опрос статусов ручных откликов (актуально для NO_OAUTH/FALLBACK)
  await runStatusPoll({ db, cfg, tg: getTelegram() }).catch((e) => console.error('status-poll:', errorMessage(e)));

  // Шаг 3: veto-таймаут (только в режиме veto с рабочим OAuth)
  if (cfg.paused || cfg.sending.mode !== 'veto') {
    console.log(`veto-sweep: пропуск (режим ${cfg.sending.mode}${cfg.paused ? ', пауза' : ''})`);
    return;
  }
  const { count } = await db
    .from('applications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .eq('status', 'queued');
  if (!count) {
    console.log('veto-sweep: очередь пуста');
    return;
  }
  const res = await processVetoQueue({ db, cfg, tg: getTelegram() });
  console.log(`veto-sweep: отправлено ${res.sent}, ошибок ${res.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
