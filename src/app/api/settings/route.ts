import { getDb, OWNER_ID } from '@/lib/db';
import type { SourceFiltersCfg } from '@/lib/config';
import { errorMessage } from '@/lib/util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
}

function sanitizeSourceFilters(value: unknown): SourceFiltersCfg {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const sources = ['hh', 'remoteok', 'wwr'] as const;
  const out: SourceFiltersCfg = {};
  for (const source of sources) {
    const raw = input[source] && typeof input[source] === 'object' ? (input[source] as Record<string, unknown>) : {};
    out[source] = {
      enabled: raw.enabled !== false,
      regions: raw.regions && typeof raw.regions === 'object' ? (raw.regions as Record<string, boolean>) : {},
      job_types: raw.job_types && typeof raw.job_types === 'object' ? (raw.job_types as Record<string, boolean>) : {},
      include_terms: cleanStringArray(raw.include_terms),
      exclude_terms: cleanStringArray(raw.exclude_terms),
      min_salary_usd: Math.max(0, Number(raw.min_salary_usd ?? 0) || 0),
      max_age_days: Math.max(0, Math.min(90, Number(raw.max_age_days ?? 14) || 14)),
    };
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { source_filters?: unknown };
    const sourceFilters = sanitizeSourceFilters(body.source_filters);
    const db = getDb();
    const { data } = await db.from('settings').select('config').eq('user_id', OWNER_ID).maybeSingle();
    const current = (data?.config ?? {}) as Record<string, unknown>;
    const next = { ...current, source_filters: sourceFilters };
    const { error } = await db.from('settings').upsert({ user_id: OWNER_ID, config: next }, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true, source_filters: sourceFilters });
  } catch (e) {
    return Response.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}
