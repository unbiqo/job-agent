import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evalsCfg, loadFileConfig } from '../src/lib/config';
import { getDb, OWNER_ID } from '../src/lib/db';
import { buildDistillInput, type FeedbackForDistill } from '../src/lib/feedback';
import { createLLM } from '../src/lib/llm/client';
import { loadPrompt } from '../src/lib/prompts';

/**
 * npm run distill:letters [-- --days=N] — дистилляция обратной связи (задача 9).
 * Читает letter_feedback за период (дефолт — всё), LLM суммаризирует повторяющиеся
 * жалобы и предлагает 2-3 правки prompts/letter.md как текстовый патч.
 * ОТЧЁТ ONLY: промпт меняет владелец вручную (+ бамп version в шапке).
 * Скоринг-промпт это не касается никогда.
 */
async function main() {
  const cfg = loadFileConfig();
  const db = getDb();
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) : null;

  let query = db
    .from('letter_feedback')
    .select('feedback_text, original_text, revised_text, status, created_at')
    .eq('user_id', OWNER_ID)
    .order('created_at', { ascending: true });
  if (days) query = query.gte('created_at', new Date(Date.now() - days * 86_400_000).toISOString());

  const { data, error } = await query;
  if (error && /find the table/i.test(error.message)) {
    console.log('Таблица letter_feedback не найдена — выполните supabase/migrations/004_letter_feedback.sql.');
    console.log('Правок пока 0 — дистиллировать нечего. Правьте письма кнопкой ✏️ в Telegram.');
    return;
  }
  if (error) throw new Error('letter_feedback select: ' + error.message);
  const rows = (data ?? []) as FeedbackForDistill[];

  console.log(`Правок писем${days ? ` за ${days} дн.` : ''}: ${rows.length}`);
  if (rows.length === 0) {
    console.log('Недостаточно данных — правьте письма кнопкой ✏️ в Telegram, потом возвращайтесь.');
    return;
  }

  const letterPrompt = loadPrompt(cfg, 'letter');
  const distillPrompt = loadPrompt(cfg, 'distill');
  const llm = createLLM(cfg, 'letters');
  const res = await llm.generate({
    system: distillPrompt.text,
    user: buildDistillInput(rows, letterPrompt.text),
    temperature: 0.3,
  });

  const header = [
    `# Дистилляция обратной связи по письмам — ${new Date().toISOString()}`,
    '',
    `- Правок проанализировано: ${rows.length}${days ? ` (за ${days} дн.)` : ' (за всё время)'}`,
    `- Текущий промпт письма: \`${letterPrompt.file}\` v${letterPrompt.version}`,
    `- Модель: \`${llm.model}\` · промпт дистилляции: \`${distillPrompt.file}\` v${distillPrompt.version}`,
    '',
    '> ОТЧЁТ ONLY: правки применяются вручную в prompts/letter.md с бампом version.',
    '> Скоринг-промпт не трогать (ограничение ТЗ).',
    '',
    '---',
    '',
  ].join('\n');

  const e = evalsCfg(cfg);
  mkdirSync(path.resolve(e.reports_dir), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(e.reports_dir, `distill-${ts}.md`);
  writeFileSync(path.resolve(reportPath), header + res.text, 'utf-8');

  console.log('\n' + header + res.text);
  console.log(`\nОтчёт: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
