import { latestLetter, manualAppliedPatch } from '@/lib/apply';
import { letterTaskCfg, loadRuntimeConfig } from '@/lib/config';
import { addUsage, emptyTally } from '@/lib/cost';
import { getDb, OWNER_ID } from '@/lib/db';
import { saveLetterEvent, saveVacancyLabel } from '@/lib/labels';
import { generateLetter } from '@/lib/letters';
import { createLLM } from '@/lib/llm/client';
import { loadProfileSmart } from '@/lib/profile';
import type { ApplicationRow, EvaluationRow, LetterRow, VacancyRow } from '@/lib/types';
import { errorMessage } from '@/lib/util';
import { responseLetterRequired } from '@/lib/vacancy-letter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface LabelRow {
  vacancy_id: string;
  label: string;
}

function syntheticApp(vacancyId: string): ApplicationRow {
  return {
    vacancy_id: vacancyId,
    user_id: OWNER_ID,
    status: 'listed',
    queued_at: null,
    sent_at: null,
    response_at: null,
    error: null,
    tg_message_id: null,
    manual: true,
    polled_at: null,
  };
}

function byPublishedDesc(a: VacancyRow | undefined, b: VacancyRow | undefined): number {
  const at = a?.published_at ? Date.parse(a.published_at) : 0;
  const bt = b?.published_at ? Date.parse(b.published_at) : 0;
  return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
}

async function loadMoreEvaluated(excludeIds: string[], limit: number) {
  const db = getDb();
  const exclude = new Set(excludeIds);
  const { data: evalRows } = await db
    .from('evaluations')
    .select('*')
    .eq('user_id', OWNER_ID)
    .eq('prefilter', 'passed')
    .gte('score', 0)
    .order('score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.max(100, limit * 8));

  const evals = ((evalRows ?? []) as EvaluationRow[]).filter((ev) => !exclude.has(ev.vacancy_id));
  const candidateIds = evals.map((ev) => ev.vacancy_id);
  if (!candidateIds.length) return [];

  const [{ data: vacRows }, { data: appRows }, { data: letterRows }, { data: labelRows }] = await Promise.all([
    db.from('vacancies').select('*').in('id', candidateIds),
    db.from('applications').select('*').eq('user_id', OWNER_ID).in('vacancy_id', candidateIds),
    db.from('letters').select('*').eq('user_id', OWNER_ID).in('vacancy_id', candidateIds).order('version', { ascending: true }),
    db.from('labels').select('vacancy_id,label').eq('user_id', OWNER_ID).eq('kind', 'vacancy').in('vacancy_id', candidateIds),
  ]);

  const vacById = new Map(((vacRows ?? []) as VacancyRow[]).map((v) => [v.id, v]));
  const appById = new Map(((appRows ?? []) as ApplicationRow[]).map((a) => [a.vacancy_id, a]));
  const letterById = new Map<string, LetterRow>();
  for (const l of (letterRows ?? []) as LetterRow[]) letterById.set(l.vacancy_id, l);
  const labelById = new Map(((labelRows ?? []) as LabelRow[]).map((l) => [l.vacancy_id, l.label]));

  return evals
    .map((ev) => {
      const vacancy = vacById.get(ev.vacancy_id);
      if (!vacancy) return null;
      const app = appById.get(ev.vacancy_id);
      const label = labelById.get(ev.vacancy_id) ?? null;
      if (app?.status === 'vetoed' || app?.status === 'sent' || app?.status === 'invited' || label === 'irrelevant') return null;
      return {
        app: app ?? syntheticApp(ev.vacancy_id),
        vacancy,
        evaluation: ev,
        letter: letterById.get(ev.vacancy_id) ?? null,
        label,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const as = a!.evaluation?.score ?? 0;
      const bs = b!.evaluation?.score ?? 0;
      if (as !== bs) return bs - as;
      return byPublishedDesc(a!.vacancy, b!.vacancy);
    })
    .slice(0, limit);
}

async function generateApprovedLetter(vacancyId: string, force = false) {
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const existing = await latestLetter(db, vacancyId);
  if (existing && !force) return existing;

  const { data: vac } = await db.from('vacancies').select('*').eq('id', vacancyId).maybeSingle();
  if (!vac) throw new Error('Vacancy not found');
  const v = vac as VacancyRow;
  if (responseLetterRequired(v) === false) {
    await db.from('applications').upsert(
      {
        vacancy_id: vacancyId,
        user_id: OWNER_ID,
        status: 'listed',
        manual: true,
        error: null,
      },
      { onConflict: 'vacancy_id,user_id' },
    );
    return null;
  }

  const { data: evRow } = await db
    .from('evaluations')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .maybeSingle();
  const ev = evRow as EvaluationRow | null;
  const resumeVersion = ev?.resume_version ?? Object.keys(cfg.scoring.resume_versions)[0] ?? '';
  const profile = await loadProfileSmart(db, cfg);
  const llm = createLLM(cfg, 'letters');
  const usage = emptyTally();

  const res = await generateLetter(
    llm,
    cfg,
    profile,
    v,
    {
      resume_version: resumeVersion,
      letter_hook: ev?.letter_hook ?? '',
      red_flags: ev?.red_flags ?? [],
    },
  );
  addUsage(usage, res.usage, letterTaskCfg(cfg), {
    task: 'letter',
    prompt_file: res.prompt.file,
    prompt_version: res.prompt.version,
    model: llm.model,
  });

  await db.from('letters').upsert(
    {
      vacancy_id: vacancyId,
      user_id: OWNER_ID,
      text: res.text,
      version: existing ? existing.version + 1 : 1,
      needs_review: res.needsReview,
    },
    { onConflict: 'vacancy_id,user_id,version' },
  );
  await db.from('applications').upsert(
    {
      vacancy_id: vacancyId,
      user_id: OWNER_ID,
      status: 'listed',
      manual: true,
      error: null,
    },
    { onConflict: 'vacancy_id,user_id' },
  );
  await saveLetterEvent(db, vacancyId, 'letter_ok').catch(() => undefined);

  return {
    vacancy_id: vacancyId,
    user_id: OWNER_ID,
    text: res.text,
    version: existing ? existing.version + 1 : 1,
    needs_review: res.needsReview,
    created_at: new Date().toISOString(),
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { action?: string; vacancyId?: string; force?: boolean; excludeIds?: string[]; limit?: number };
    if (body.action === 'load_more') {
      const limit = Math.max(1, Math.min(20, Number(body.limit ?? 10)));
      const excludeIds = Array.isArray(body.excludeIds) ? body.excludeIds.map((x) => String(x)) : [];
      const items = await loadMoreEvaluated(excludeIds, limit);
      return Response.json({ ok: true, items });
    }

    const vacancyId = body.vacancyId?.trim();
    if (!vacancyId) return Response.json({ ok: false, error: 'vacancyId is required' }, { status: 400 });

    const db = getDb();
    if (body.action === 'approve') {
      await saveVacancyLabel(db, vacancyId, 'relevant');
      const letter = await generateApprovedLetter(vacancyId, body.force === true);
      return Response.json({ ok: true, letter, letterRequired: letter !== null });
    }

    if (body.action === 'skip') {
      await saveVacancyLabel(db, vacancyId, 'irrelevant');
      await db
        .from('applications')
        .upsert({ vacancy_id: vacancyId, user_id: OWNER_ID, status: 'vetoed', error: null }, { onConflict: 'vacancy_id,user_id' });
      return Response.json({ ok: true });
    }

    if (body.action === 'mark_applied') {
      await db.from('applications').upsert({ vacancy_id: vacancyId, user_id: OWNER_ID, ...manualAppliedPatch() }, { onConflict: 'vacancy_id,user_id' });
      await saveLetterEvent(db, vacancyId, 'letter_ok').catch(() => undefined);
      return Response.json({ ok: true });
    }

    if (body.action === 'mark_interview') {
      await db
        .from('applications')
        .upsert(
          { vacancy_id: vacancyId, user_id: OWNER_ID, status: 'invited', manual: true, response_at: new Date().toISOString(), error: null },
          { onConflict: 'vacancy_id,user_id' },
        );
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}
