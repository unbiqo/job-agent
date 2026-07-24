import type { RunStats } from './types';

export interface BriefItem {
  title: string;
  employer?: string | null;
  score?: number | null;
  note?: string;
}

export interface DigestData {
  runLabel: string;
  mode: string;
  hhMode?: string;
  paused: boolean;
  stats: RunStats;
  sent: BriefItem[];
  queued: BriefItem[];
  manual: BriefItem[];
  failed: BriefItem[];
  statusUpdates: string[];
  followUps: BriefItem[];
  tokensIn: number;
  tokensOut: number;
  costRun: number;
  costToday: number;
  costAlert: boolean;
}

function itemLine(x: BriefItem): string {
  const score = x.score != null ? `${x.score}/10 · ` : '';
  const emp = x.employer ? ` @ ${x.employer}` : '';
  const note = x.note ? ` — ${x.note}` : '';
  return `• ${score}${x.title}${emp}${note}`;
}

function section(header: string, items: BriefItem[], max = 10): string[] {
  if (!items.length) return [];
  const lines = items.slice(0, max).map(itemLine);
  if (items.length > max) lines.push(`  …и ещё ${items.length - max}`);
  return [`${header} (${items.length}):`, ...lines];
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Дайджест после каждого прогона (шаг 10 пайплайна). */
export function buildDigest(d: DigestData): string {
  const s = d.stats;
  const hhModeSuffix = d.hhMode && d.hhMode !== 'FULL' ? ` · hh: ${d.hhMode}` : '';
  const lines: string[] = [
    `📊 JobAgent · ${d.runLabel} · режим: ${d.mode}${hhModeSuffix}${d.paused ? ' · ⏸ ПАУЗА' : ''}`,
  ];
  lines.push(
    `Собрано: ${s.collected} (новых ${s.new}) · префильтр −${s.excluded} · оценено ${s.scored}, выше порога ${s.above_threshold}`,
  );
  if (s.lettered || s.letters_rejected) {
    lines.push(`Письма: ${s.lettered}${s.letters_rejected ? ` (отклонено guardrail: ${s.letters_rejected})` : ''}`);
  }
  lines.push(...section('📤 Отправлено', d.sent));
  lines.push(...section('⏳ Ждут решения', d.queued));
  lines.push(...section('✋ Нужен ручной отклик (тест)', d.manual));
  lines.push(...section('❌ Ошибки отправки', d.failed));
  if (d.statusUpdates.length) {
    lines.push(`📈 Статусы (${d.statusUpdates.length}):`, ...d.statusUpdates.slice(0, 10).map((u) => `• ${u}`));
  }
  lines.push(...section('⏰ Фоллоу-ап — нет ответа', d.followUps));
  lines.push(
    `💰 ${fmtTokens(d.tokensIn)} in / ${fmtTokens(d.tokensOut)} out · $${d.costRun.toFixed(4)} за прогон · $${d.costToday.toFixed(4)} сегодня`,
  );
  if (d.costAlert) lines.push('⚠️ Дневная стоимость превысила порог из настроек!');
  if (s.errors.length) {
    lines.push(`⚠️ Ошибки прогона (${s.errors.length}):`, ...s.errors.slice(0, 3).map((e) => `• ${e}`));
  }
  return lines.join('\n');
}
